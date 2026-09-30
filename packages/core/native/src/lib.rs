mod reminders;

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;

pub struct ReminderHandle(Result<reminders::Store, String>);
pub struct ResultBytes(Vec<u8>);

#[unsafe(no_mangle)]
pub extern "C" fn oc_abi_version_v1() -> u32 {
    1
}

/// Opens an opaque store handle, including an error-bearing handle on I/O failure.
/// # Safety
/// A non-null `data` must address `len` readable bytes for the duration of the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn oc_reminders_open_v1(data: *const u8, len: u32) -> *mut ReminderHandle {
    catch_unwind(|| {
        let store = unsafe { input(data, len) }.and_then(reminders::Store::open);
        Box::into_raw(Box::new(ReminderHandle(store)))
    })
    .unwrap_or(ptr::null_mut())
}

#[unsafe(no_mangle)]
/// # Safety
/// `handle` must be null or a live handle from open, exclusively borrowed during
/// this call. Non-null `data` must address `len` readable bytes. Free the returned
/// result exactly once using `oc_result_free_v1`.
pub unsafe extern "C" fn oc_reminders_call_v1(
    handle: *mut ReminderHandle,
    data: *const u8,
    len: u32,
) -> *mut ResultBytes {
    let result = catch_unwind(AssertUnwindSafe(|| {
        if handle.is_null() {
            return Err("Reminder store is closed".to_owned());
        }
        let text = unsafe { input(data, len) }?;
        match &mut unsafe { &mut *handle }.0 {
            Ok(store) => store.call(text),
            Err(error) => Err(error.clone()),
        }
    }))
    .unwrap_or_else(|_| Err("Native reminder operation panicked".to_owned()));
    let value = match result {
        Ok(value) => serde_json::json!({ "ok": true, "value": value }),
        Err(error) => serde_json::json!({ "ok": false, "error": error }),
    };
    Box::into_raw(Box::new(ResultBytes(value.to_string().into_bytes())))
}

#[unsafe(no_mangle)]
/// # Safety
/// `handle` must be null or an unfreed handle from open, with no concurrent calls.
pub unsafe extern "C" fn oc_reminders_close_v1(handle: *mut ReminderHandle) {
    if !handle.is_null() {
        drop(unsafe { Box::from_raw(handle) });
    }
}

#[unsafe(no_mangle)]
/// # Safety
/// `result` must be null or a live result from call. The returned bytes are borrowed
/// until result_free and must not be modified or retained after that point.
pub unsafe extern "C" fn oc_result_data_v1(result: *const ResultBytes) -> *const u8 {
    if result.is_null() {
        return ptr::null();
    }
    unsafe { &*result }.0.as_ptr()
}

#[unsafe(no_mangle)]
/// # Safety
/// `result` must be null or a live result from call. Length is in bytes.
pub unsafe extern "C" fn oc_result_len_v1(result: *const ResultBytes) -> u32 {
    if result.is_null() {
        return 0;
    }
    unsafe { &*result }.0.len() as u32
}

#[unsafe(no_mangle)]
/// # Safety
/// `result` must be null or an unfreed result from call, with no live borrowed views.
pub unsafe extern "C" fn oc_result_free_v1(result: *mut ResultBytes) {
    if !result.is_null() {
        drop(unsafe { Box::from_raw(result) });
    }
}

unsafe fn input<'a>(data: *const u8, len: u32) -> Result<&'a str, String> {
    if data.is_null() || len == 0 || len > 65536 {
        return Err("Invalid native reminder input".to_owned());
    }
    std::str::from_utf8(unsafe { std::slice::from_raw_parts(data, len as usize) })
        .map_err(|_| "Reminder input must be UTF-8".to_owned())
}
