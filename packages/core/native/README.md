# Native reminders

One `opencode-native` Rust `cdylib`, loaded lazily through Bun's versioned C FFI.
The TUI owns one connection handle per instance. Rust owns parsing and a shared
SQLite WAL store at `<state>/reminders.sqlite3`, separate from session data.

- `bun run script/build-native.ts` from `packages/core` builds the source-mode library.
- `cargo test --locked` and `cargo clippy --locked --all-targets -- -D warnings` from this directory verify the native implementation.
- `bun test test/native/reminders.test.ts` from `packages/core` exercises real FFI and cross-process persistence.
- CLI builds embed the library using `packages/opencode/script/native-artifacts.ts`.

Linux x64 glibc is the initial supported target. Other builds have an explicit
unavailable descriptor. Compiled binaries never probe an installed or source-mode
library. SQLite is bundled, so deployment does not require a system SQLite library.

Idle polls read `PRAGMA data_version` and compare the next due timestamp. They
return no snapshot until another connection writes, this connection mutates a
reminder, or the next reminder becomes due. No recurring row scan or renderer
update is needed. A due reminder remains active until explicitly addressed,
snoozed, rescheduled, or deleted. TUI instances refresh once per second.

Natural text accepts relative durations, tomorrow/today, weekdays, ISO dates,
and local clock times, with the message before or after the time. Scheduling has
a confirmation step displaying the extracted message and local due date. A
day without a clock defaults to 9am for today/tomorrow. Clock-only inputs use
their next occurrence. Invalid or past times are rejected.

## Agent tools

`reminder_tools` reveals the management catalog and input schemas for the next
model turn of the current user request:

- `reminder_list`: inspect all reminders or filter by status/message.
- `reminder_create`: schedule from natural text and return the created reminder ID.
- `reminder_update`: edit the message and/or time without changing addressed status.
- `reminder_complete`: mark addressed and remove its active notification.
- `reminder_snooze`: reschedule, including reactivating an addressed reminder.
- `reminder_delete`: permanently remove it.

Agent tools use the same global state file as the TUI. Management tools follow
normal per-tool permission rules. Native connections are opened only during
execution and closed with the execution scope. Creation returns the inserted
row ID directly from its connection, so concurrent identical reminder messages
cannot confuse the returned ID. Reminders notify users; they do not schedule
agent execution.

## ABI ownership

Inputs are borrowed UTF-8 byte slices with explicit u32 lengths, bounded to 64 KiB.
Opaque store handles and result allocations are Rust-owned and have separate free
functions. Results contain a UTF-8 JSON response envelope; `oc_result_len_v1`
counts **bytes**. The TS adapter copies/decodes the result before freeing it in
`finally`, and closes store handles on TUI cleanup. Never free a handle or result
twice, retain a native view after freeing, or call concurrently on one handle.
All computational entrypoints catch Rust unwinding panics. This is not process
isolation from allocator aborts or invalid caller-supplied pointers.
