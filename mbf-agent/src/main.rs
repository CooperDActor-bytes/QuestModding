mod requests;
mod zip;
mod manifest;
mod axml;
mod patching;
mod bmbf_res;
mod mod_man;
mod handlers;

use crate::requests::Request;
use anyhow::{Context, Result};
use log::{error, Level};
use requests::Response;
use std::{io::{BufRead, BufReader, Write}, process::Command};

const APK_ID: &str = "com.beatgames.beatsaber";


pub fn get_apk_path() -> Result<Option<String>> {
    let pm_output = Command::new("pm")
        .args(["path", APK_ID])
        .output()
        .context("Failed to get APK path")?;
    if 8 > pm_output.stdout.len() {
        // App not installed
        Ok(None)
    }   else {
        Ok(Some(std::str::from_utf8(pm_output.stdout.split_at(8).1)?
            .trim_end()
            .to_owned()))
    }
}

struct ResponseLogger {}

impl log::Log for ResponseLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= Level::Debug
    }

    fn log(&self, record: &log::Record) {
        // Ignore errors, logging should be infallible and we don't want to panic
        let _result = write_response(Response::Log {
            message: format!("{}", record.args()),
            level: match record.level() {
                Level::Debug => requests::LogLevel::Debug,
                Level::Info => requests::LogLevel::Info,
                Level::Warn => requests::LogLevel::Warn,
                Level::Error => requests::LogLevel::Error,
                Level::Trace => requests::LogLevel::Trace
            }
        });
    }

    fn flush(&self) {
        let _ = std::io::stdout().flush();
    }
}

fn write_response(response: Response) -> Result<()> {
    let mut lock = std::io::stdout().lock();
    serde_json::to_writer(&mut lock, &response).context("Failed to serialize response")?;
    writeln!(lock)?;
    Ok(())
}

static LOGGER: ResponseLogger = ResponseLogger {};

fn main() -> Result<()> {
    log::set_logger(&LOGGER).expect("Failed to set up logging");
    log::set_max_level(log::LevelFilter::Info);

    let mut reader = BufReader::new(std::io::stdin());
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let req: Request = serde_json::from_str(&line)?;

    match handlers::handle_request(req) {
        Ok(resp) => write_response(resp)?,
        Err(err) => error!("Request failed: {err}")
    };
    Ok(())
}