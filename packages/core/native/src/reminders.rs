use chrono::{DateTime, Duration, Local, NaiveTime, TimeZone};
use chrono_english::{Dialect, parse_date_string};
use regex::Regex;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::OnceLock;
use std::time::Duration as Timeout;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Poll {
        now: i64,
    },
    Parse {
        text: String,
        now: i64,
    },
    Create {
        title: String,
        due: i64,
        now: i64,
    },
    Update {
        id: i64,
        title: Option<String>,
        due: Option<i64>,
        now: i64,
    },
    Complete {
        id: i64,
        now: i64,
    },
    Snooze {
        id: i64,
        due: i64,
        now: i64,
    },
    Delete {
        id: i64,
    },
}

#[derive(Serialize)]
struct Reminder {
    id: i64,
    title: String,
    due: i64,
    completed: Option<i64>,
}

pub struct Store {
    db: Connection,
    version: Option<i64>,
    next_due: Option<i64>,
    last_now: Option<i64>,
}

impl Store {
    pub fn open(path: &str) -> Result<Self, String> {
        let db = Connection::open(path).map_err(error)?;
        db.busy_timeout(Timeout::from_millis(100)).map_err(error)?;
        db.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             CREATE TABLE IF NOT EXISTS reminder (
               id INTEGER PRIMARY KEY,
               title TEXT NOT NULL,
               due INTEGER NOT NULL,
               completed INTEGER
             );
             CREATE INDEX IF NOT EXISTS reminder_pending_due ON reminder(due) WHERE completed IS NULL;",
        ).map_err(error)?;
        Ok(Self {
            db,
            version: None,
            next_due: None,
            last_now: None,
        })
    }

    pub fn call(&mut self, text: &str) -> Result<Value, String> {
        let request: Request = serde_json::from_str(text).map_err(error)?;
        match request {
            Request::Parse { text, now } => {
                let (title, due) = parse(&text, now)?;
                return Ok(json!({ "title": title, "due": due }));
            }
            Request::Poll { now } => return self.poll(now),
            Request::Create { title, due, now } => {
                let title = title.trim();
                if title.is_empty() || title.len() > 4096 {
                    return Err("Provide a reminder message (up to 4096 bytes)".to_owned());
                }
                future(due, now)?;
                self.db
                    .execute(
                        "INSERT INTO reminder (title, due) VALUES (?1, ?2)",
                        params![title, due],
                    )
                    .map_err(error)?;
                self.version = None;
                return Ok(json!(Reminder {
                    id: self.db.last_insert_rowid(),
                    title: title.to_owned(),
                    due,
                    completed: None,
                }));
            }
            Request::Update {
                id,
                title,
                due,
                now,
            } => {
                if title.is_none() && due.is_none() {
                    return Err("Provide a new title or time".to_owned());
                }
                let title = title.as_deref().map(str::trim);
                if title.is_some_and(|title| title.is_empty() || title.len() > 4096) {
                    return Err("Provide a reminder message (up to 4096 bytes)".to_owned());
                }
                if let Some(due) = due {
                    future(due, now)?;
                }
                changed(self.db.execute(
                    "UPDATE reminder SET title = COALESCE(?1, title), due = COALESCE(?2, due) WHERE id = ?3",
                    params![title, due, id],
                ).map_err(error)?)?;
            }
            Request::Complete { id, now } => {
                changed(self.db.execute("UPDATE reminder SET completed = ?1 WHERE id = ?2 AND completed IS NULL", params![now, id]).map_err(error)?)?;
            }
            Request::Snooze { id, due, now } => {
                future(due, now)?;
                changed(
                    self.db
                        .execute(
                            "UPDATE reminder SET due = ?1, completed = NULL WHERE id = ?2",
                            params![due, id],
                        )
                        .map_err(error)?,
                )?;
            }
            Request::Delete { id } => {
                changed(
                    self.db
                        .execute("DELETE FROM reminder WHERE id = ?1", [id])
                        .map_err(error)?,
                )?;
            }
        }
        // data_version only changes for writes on *other* connections.
        self.version = None;
        Ok(Value::Null)
    }

    fn poll(&mut self, now: i64) -> Result<Value, String> {
        let version = self
            .db
            .query_row("PRAGMA data_version", [], |row| row.get::<_, i64>(0))
            .map_err(error)?;
        let backwards = self.last_now.is_some_and(|last| now < last);
        self.last_now = Some(now);
        if !backwards && self.version == Some(version) && self.next_due.is_none_or(|due| due > now)
        {
            return Ok(Value::Null);
        }
        self.version = None;
        // One read transaction prevents a concurrent write from being missed
        // between reading the revision and the rows.
        let tx = self.db.transaction().map_err(error)?;
        let version = tx
            .query_row("PRAGMA data_version", [], |row| row.get::<_, i64>(0))
            .map_err(error)?;
        let reminders = tx.prepare("SELECT id, title, due, completed FROM reminder ORDER BY completed IS NOT NULL, due, id")
            .map_err(error)?
            .query_map([], |row| Ok(Reminder { id: row.get(0)?, title: row.get(1)?, due: row.get(2)?, completed: row.get(3)? }))
            .map_err(error)?.collect::<Result<Vec<_>, _>>().map_err(error)?;
        self.next_due = tx
            .query_row(
                "SELECT MIN(due) FROM reminder WHERE completed IS NULL AND due > ?1",
                [now],
                |row| row.get(0),
            )
            .optional()
            .map_err(error)?
            .flatten();
        tx.commit().map_err(error)?;
        self.version = Some(version);
        Ok(json!({ "reminders": reminders, "now": now }))
    }
}

fn changed(count: usize) -> Result<(), String> {
    if count == 0 {
        return Err(
            "This reminder was already addressed or deleted in another terminal".to_owned(),
        );
    }
    Ok(())
}

fn future(due: i64, now: i64) -> Result<(), String> {
    if due <= now || Local.timestamp_millis_opt(due).single().is_none() {
        return Err("Choose a time in the future".to_owned());
    }
    Ok(())
}

fn error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn time_pattern() -> &'static str {
    r"(?:(?:in\s+)?(?:\d+|one|two|three|four|five|ten|fifteen|twenty|thirty|a|an|half(?:\s+an?)?)\s*(?:seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)(?:\s+(?:and\s+)?\d+\s*(?:seconds?|minutes?|hours?))?|(?:(?:on\s+)?(?:today|tomorrow|(?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\d{4}-\d{2}-\d{2})(?:\s+(?:at\s+)?(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|noon|midnight))?)|(?:at\s+)?(?:\d{1,2}:\d{2}(?:\s*(?:am|pm))?|\d{1,2}\s*(?:am|pm)|noon|midnight))"
}

fn parse(text: &str, now: i64) -> Result<(String, i64), String> {
    if text.len() > 4096 {
        return Err("Reminder text is too long".to_owned());
    }
    let text = text.trim();
    let text = text
        .strip_prefix("remind me to ")
        .or_else(|| text.strip_prefix("remind me "))
        .unwrap_or(text);
    static START: OnceLock<Regex> = OnceLock::new();
    static END: OnceLock<Regex> = OnceLock::new();
    let start = START.get_or_init(|| {
        Regex::new(&format!(
            r"(?i)^({})(?:\s*[,;:]\s*|\s+)(.+)$",
            time_pattern()
        ))
        .unwrap()
    });
    let end = END.get_or_init(|| {
        Regex::new(&format!(
            r"(?i)^(.+?)(?:\s*[,;]\s*|\s+)({})$",
            time_pattern()
        ))
        .unwrap()
    });
    let (title, time) = if let Some(parts) = start.captures(text) {
        (
            parts[2].trim().trim_start_matches("to ").to_owned(),
            parts[1].to_lowercase(),
        )
    } else if let Some(parts) = end.captures(text) {
        (parts[1].trim().to_owned(), parts[2].to_lowercase())
    } else {
        return Err("Include a time and message, e.g. ‘in 20 minutes check the build’ or ‘call Sam tomorrow at 9am’".to_owned());
    };
    if title.is_empty() {
        return Err("Provide a reminder message".to_owned());
    }
    let base = Local
        .timestamp_millis_opt(now)
        .single()
        .ok_or("Invalid current time")?;
    let due = parse_time(&time, base)?;
    future(due, now)?;
    Ok((title, due))
}

fn parse_time(text: &str, base: DateTime<Local>) -> Result<i64, String> {
    let text = text
        .trim_start_matches("in ")
        .trim_start_matches("at ")
        .trim_start_matches("on ");
    let text = text
        .replace(" at ", " ")
        .replace("noon", "12pm")
        .replace("midnight", "12am");
    let words = [
        ("one", "1"),
        ("two", "2"),
        ("three", "3"),
        ("four", "4"),
        ("five", "5"),
        ("ten", "10"),
        ("fifteen", "15"),
        ("twenty", "20"),
        ("thirty", "30"),
        ("a", "1"),
        ("an", "1"),
    ];
    let text = words
        .iter()
        .find_map(|(word, number)| {
            text.strip_prefix(&format!("{word} "))
                .map(|rest| format!("{number} {rest}"))
        })
        .unwrap_or(text);
    if let Some(rest) = text.strip_prefix("half ") {
        let rest = rest.trim_start_matches("an ").trim_start_matches("a ");
        let seconds = if rest.starts_with("hour") {
            1800
        } else if rest.starts_with("min") {
            30
        } else {
            return Err("Use ‘half hour’ or ‘half minute’".to_owned());
        };
        return base
            .checked_add_signed(Duration::seconds(seconds))
            .map(|date| date.timestamp_millis())
            .ok_or("Time is out of range".to_owned());
    }
    static UNITS: OnceLock<Regex> = OnceLock::new();
    let units = UNITS.get_or_init(|| Regex::new(r"^(\d+)\s*(s(?:ec(?:ond)?s?)?|m(?:in(?:ute)?s?)?|h(?:r?s?|ours?)|d(?:ays?)?|w(?:eeks?)?)(?:\s+(?:and\s+)?(.+))?$").unwrap());
    if let Some(parts) = units.captures(&text) {
        let count = parts[1].parse::<i64>().map_err(error)?;
        let scale = match parts[2].chars().next().unwrap() {
            's' => 1,
            'm' => 60,
            'h' => 3600,
            'd' => 86400,
            _ => 604800,
        };
        let duration = count
            .checked_mul(scale)
            .and_then(Duration::try_seconds)
            .ok_or("Duration is too large")?;
        let due = base
            .checked_add_signed(duration)
            .ok_or("Time is out of range")?;
        return match parts.get(3) {
            Some(rest) => parse_time(rest.as_str(), due),
            None => Ok(due.timestamp_millis()),
        };
    }
    if let Some(time) = parse_clock(&text)? {
        let day = if time > base.time() {
            base.date_naive()
        } else {
            base.date_naive().succ_opt().ok_or("Time is out of range")?
        };
        return Local
            .from_local_datetime(&day.and_time(time))
            .single()
            .map(|date| date.timestamp_millis())
            .ok_or(
                "That local time is ambiguous or does not exist; choose another time".to_owned(),
            );
    }
    let text = if text.starts_with("tomorrow") || text.starts_with("today") {
        let tomorrow = text.starts_with("tomorrow");
        let clock = text
            .split_once(' ')
            .map(|(_, clock)| clock)
            .unwrap_or("9am");
        let day = base
            .date_naive()
            .checked_add_signed(Duration::days(i64::from(tomorrow)))
            .ok_or("Time is out of range")?;
        format!("{day} {clock}")
    } else {
        text
    };
    // Normalize calendar clock components ourselves, including 12am/12pm and
    // space-separated am/pm. chrono-english otherwise treats 12pm as hour 24.
    static CALENDAR_CLOCK: OnceLock<Regex> = OnceLock::new();
    let calendar_clock = CALENDAR_CLOCK
        .get_or_init(|| Regex::new(r"^(.+?)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)$").unwrap());
    let text = if let Some(parts) = calendar_clock.captures(&text) {
        let time = parse_clock(&parts[2])?.ok_or("Invalid clock time")?;
        format!("{} {}", &parts[1], time.format("%H:%M"))
    } else {
        text
    };
    let date = parse_date_string(&text, base, Dialect::Us).map_err(|_| {
        "Could not understand that time; use e.g. ‘tomorrow at 9am’ or ‘in 20 minutes’".to_owned()
    })?;
    Ok(date.timestamp_millis())
}

fn parse_clock(text: &str) -> Result<Option<NaiveTime>, String> {
    static CLOCK: OnceLock<Regex> = OnceLock::new();
    let clock = CLOCK.get_or_init(|| Regex::new(r"^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$").unwrap());
    let Some(parts) = clock.captures(text) else {
        return Ok(None);
    };
    let hour = parts[1].parse::<u32>().map_err(error)?;
    let minute = parts
        .get(2)
        .map(|part| part.as_str().parse::<u32>())
        .transpose()
        .map_err(error)?
        .unwrap_or(0);
    let hour = match parts.get(3).map(|part| part.as_str()) {
        Some("am") if (1..=12).contains(&hour) => hour % 12,
        Some("pm") if (1..=12).contains(&hour) => hour % 12 + 12,
        None => hour,
        _ => return Err("Use an hour from 1 to 12 with am/pm".to_owned()),
    };
    NaiveTime::from_hms_opt(hour, minute, 0)
        .map(Some)
        .ok_or("Invalid clock time".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn natural_text() {
        let now = Local
            .with_ymd_and_hms(2026, 9, 29, 12, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis();
        for (text, title, delta) in [
            ("in 20 minutes check the build", "check the build", 1200000),
            ("check the build in 20 minutes", "check the build", 1200000),
            ("in an hour, call Sam", "call Sam", 3600000),
            ("in half hour stretch", "stretch", 1800000),
            ("in half an hour stretch", "stretch", 1800000),
            ("in 1 hour and 30 minutes check CI", "check CI", 5400000),
            (
                "remind me to call Sam tomorrow at 9am",
                "call Sam",
                21 * 3600000,
            ),
            ("tomorrow at 9am call Sam", "call Sam", 21 * 3600000),
            ("at 11am stand up", "stand up", 23 * 3600000),
            ("tomorrow at noon call Sam", "call Sam", 24 * 3600000),
            ("call Sam on tomorrow at 9 am", "call Sam", 21 * 3600000),
            ("next friday at 12pm lunch", "lunch", 3 * 86400000),
        ] {
            assert_eq!(
                parse(text, now).unwrap_or_else(|error| panic!("{text}: {error}")),
                (title.to_owned(), now + delta),
                "{text}"
            );
        }
        for text in [
            "check the build",
            "in 0 minutes check",
            "2020-01-01 check",
            "tomorrow",
            "in 999999999999999999999 hours check",
            "tomorrow at 99pm check",
        ] {
            assert!(parse(text, now).is_err(), "{text}");
        }
    }

    #[test]
    fn shared_store_due_and_restart() {
        let path = std::env::temp_dir().join(format!("oc-reminder-{}.sqlite3", std::process::id()));
        let mut a = Store::open(path.to_str().unwrap()).unwrap();
        let mut b = Store::open(path.to_str().unwrap()).unwrap();
        a.db.execute("DELETE FROM reminder", []).unwrap();
        assert_eq!(
            b.call(r#"{"op":"poll","now":1000}"#).unwrap()["reminders"],
            json!([])
        );
        assert!(b.call(r#"{"op":"poll","now":1001}"#).unwrap().is_null());
        a.call(r#"{"op":"create","title":"check","due":2000,"now":1000}"#)
            .unwrap();
        let rows = b.call(r#"{"op":"poll","now":1001}"#).unwrap();
        let id = rows["reminders"][0]["id"].as_i64().unwrap();
        assert!(b.call(r#"{"op":"poll","now":1999}"#).unwrap().is_null());
        assert!(!b.call(r#"{"op":"poll","now":2000}"#).unwrap().is_null());
        assert!(b.call(r#"{"op":"poll","now":2001}"#).unwrap().is_null());
        a.call(&json!({"op":"complete", "id":id, "now":2001}).to_string())
            .unwrap();
        assert_eq!(
            b.call(r#"{"op":"poll","now":2002}"#).unwrap()["reminders"][0]["completed"],
            2001
        );
        assert!(
            b.call(&json!({"op":"complete", "id":id, "now":2002}).to_string())
                .is_err()
        );
        b.call(&json!({"op":"snooze", "id":id, "due":3000, "now":2002}).to_string())
            .unwrap();
        drop(a);
        let mut a = Store::open(path.to_str().unwrap()).unwrap();
        assert!(
            a.call(r#"{"op":"poll","now":2003}"#).unwrap()["reminders"][0]["completed"].is_null()
        );
        a.call(&json!({"op":"delete", "id":id}).to_string())
            .unwrap();
        assert_eq!(
            b.call(r#"{"op":"poll","now":3000}"#).unwrap()["reminders"],
            json!([])
        );
        drop(a);
        drop(b);
        std::fs::remove_file(path).unwrap();
    }
}
