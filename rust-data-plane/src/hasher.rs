use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

use crate::error::{AppError, AppResult};

pub fn sha256_file(path: &Path) -> AppResult<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

pub fn sha256_file_with_reader<R: Read>(mut reader: R) -> AppResult<String> {
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 1024 * 1024];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

pub fn stable_sha256_file(path: &Path, retries: usize) -> AppResult<String> {
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;

    let mut last_error = None;
    for _ in 0..=retries {
        let mut file = std::fs::File::open(path)?;
        let before = file.metadata()?;
        let hash = sha256_file_with_reader(&mut file)?;
        let after = file.metadata()?;

        #[cfg(unix)]
        let unchanged = before.dev() == after.dev()
            && before.ino() == after.ino()
            && before.len() == after.len()
            && before.mtime() == after.mtime()
            && before.mtime_nsec() == after.mtime_nsec();
        #[cfg(not(unix))]
        let unchanged =
            before.len() == after.len() && before.modified().ok() == after.modified().ok();

        if unchanged {
            return Ok(hash);
        }
        last_error = Some(AppError::FileChurn(path.display().to_string()));
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    Err(last_error.unwrap_or_else(|| AppError::FileChurn(path.display().to_string())))
}

pub fn sha256_bytes(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}
