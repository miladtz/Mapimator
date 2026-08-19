use serde::Serialize;
use std::{
    collections::HashSet,
    fs,
    fs::File,
    io::{Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::Mutex,
    thread::JoinHandle,
};
use tauri::{ipc::InvokeBody, Manager, State};
use zip::{write::SimpleFileOptions, CompressionMethod, DateTime, ZipArchive, ZipWriter};

const SMOKE_FRAME_BYTES: usize = 1920 * 1080 * 4;
const PORTABLE_MANIFEST_PATH: &str = "manifest.json";
const PORTABLE_PROJECT_PATH: &str = "project.json";
const MAX_PORTABLE_JSON_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Default)]
struct ExportState(Mutex<Option<ExportSession>>);

struct ExportSession {
    child: Child,
    stdin: Option<ChildStdin>,
    stderr_reader: JoinHandle<Result<String, String>>,
    output_path: PathBuf,
    frame_bytes: usize,
    frames_written: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportResult {
    frames_written: usize,
    stderr: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EncoderProbeResult {
    encoder: &'static str,
    display_name: &'static str,
    diagnostics: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PortableProjectPayload {
    manifest_json: String,
    project_json: String,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ExportState::default())
        .invoke_handler(tauri::generate_handler![
            ffmpeg_resource_path,
            render_test_mp4,
            start_project_export,
            write_project_export_frame,
            finish_project_export,
            abort_project_export,
            select_h264_encoder,
            export_portable_project,
            import_portable_project
        ])
        .run(tauri::generate_context!())
        .expect("error while running MapMotion Studio");
}

#[tauri::command]
fn export_portable_project(
    output_path: String,
    manifest_json: String,
    project_json: String,
) -> Result<(), String> {
    write_portable_project(
        PathBuf::from(output_path),
        manifest_json.as_bytes(),
        project_json.as_bytes(),
    )
}

fn write_portable_project(
    output_path: PathBuf,
    manifest_json: &[u8],
    project_json: &[u8],
) -> Result<(), String> {
    if manifest_json.len() as u64 > MAX_PORTABLE_JSON_BYTES
        || project_json.len() as u64 > MAX_PORTABLE_JSON_BYTES
    {
        return Err("Portable project JSON exceeds the Milestone 1 size limit.".into());
    }
    let parent = output_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or("Portable project destination has no valid parent directory.")?;
    if !parent.is_dir() {
        return Err("Portable project destination directory does not exist.".into());
    }
    let file_name = output_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Portable project destination filename is invalid.")?;
    let temporary_path = parent.join(format!(".{file_name}.{}.tmp", std::process::id()));
    let write_result = (|| -> Result<(), String> {
        let file = File::create(&temporary_path)
            .map_err(|error| format!("Unable to create portable project package: {error}"))?;
        let mut archive = ZipWriter::new(file);
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .last_modified_time(DateTime::default());
        archive
            .start_file(PORTABLE_MANIFEST_PATH, options)
            .map_err(|error| format!("Unable to write portable project manifest: {error}"))?;
        archive
            .write_all(manifest_json)
            .map_err(|error| format!("Unable to write portable project manifest: {error}"))?;
        archive
            .start_file(PORTABLE_PROJECT_PATH, options)
            .map_err(|error| format!("Unable to write portable project payload: {error}"))?;
        archive
            .write_all(project_json)
            .map_err(|error| format!("Unable to write portable project payload: {error}"))?;
        let file = archive
            .finish()
            .map_err(|error| format!("Unable to finish portable project package: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Unable to flush portable project package: {error}"))?;
        if output_path.exists() {
            fs::remove_file(&output_path)
                .map_err(|error| format!("Unable to replace portable project package: {error}"))?;
        }
        fs::rename(&temporary_path, &output_path)
            .map_err(|error| format!("Unable to finalize portable project package: {error}"))?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    write_result
}

#[tauri::command]
fn import_portable_project(input_path: String) -> Result<PortableProjectPayload, String> {
    read_portable_project(PathBuf::from(input_path))
}

fn read_portable_project(input_path: PathBuf) -> Result<PortableProjectPayload, String> {
    let file = File::open(input_path)
        .map_err(|error| format!("Unable to open portable project package: {error}"))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|error| format!("File is not a valid portable project archive: {error}"))?;
    if archive.len() > 2 {
        return Err("Portable project contains unexpected entries.".into());
    }
    let mut names = HashSet::new();
    let mut manifest_json = None;
    let mut project_json = None;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("Unable to inspect portable project entry: {error}"))?;
        let enclosed = entry.enclosed_name().ok_or_else(|| {
            format!(
                "Portable project contains an unsafe archive path: {}.",
                entry.name()
            )
        })?;
        if enclosed.components().count() != 1 || entry.is_dir() {
            return Err(format!(
                "Portable project contains an unsupported archive path: {}.",
                entry.name()
            ));
        }
        let name = enclosed.to_string_lossy().into_owned();
        if !names.insert(name.clone()) {
            return Err(format!(
                "Portable project contains duplicate entry: {name}."
            ));
        }
        if !matches!(
            name.as_str(),
            PORTABLE_MANIFEST_PATH | PORTABLE_PROJECT_PATH
        ) {
            return Err(format!(
                "Portable project contains unexpected entry: {name}."
            ));
        }
        if entry.size() > MAX_PORTABLE_JSON_BYTES {
            return Err(format!("Portable project entry is too large: {name}."));
        }
        let mut contents = String::new();
        entry.read_to_string(&mut contents).map_err(|error| {
            format!("Portable project entry is not valid UTF-8 JSON text: {error}")
        })?;
        match name.as_str() {
            PORTABLE_MANIFEST_PATH => manifest_json = Some(contents),
            PORTABLE_PROJECT_PATH => project_json = Some(contents),
            _ => unreachable!(),
        }
    }
    Ok(PortableProjectPayload {
        manifest_json: manifest_json.ok_or("Portable project is missing manifest.json.")?,
        project_json: project_json.ok_or("Portable project is missing project.json.")?,
    })
}

#[tauri::command]
fn select_h264_encoder(app: tauri::AppHandle) -> Result<EncoderProbeResult, String> {
    let ffmpeg = ffmpeg_resource_path(app)?;
    let output = Command::new(ffmpeg)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=128x128:r=30",
            "-frames:v",
            "1",
            "-c:v",
            "h264_nvenc",
            "-f",
            "null",
            "-",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("Unable to probe NVIDIA video encoding: {error}"))?;
    let diagnostics = String::from_utf8_lossy(&output.stderr).into_owned();
    if output.status.success() {
        Ok(EncoderProbeResult {
            encoder: "h264_nvenc",
            display_name: "NVIDIA NVENC",
            diagnostics,
        })
    } else {
        Ok(EncoderProbeResult {
            encoder: "libx264",
            display_name: "Software H.264",
            diagnostics,
        })
    }
}

#[tauri::command]
fn start_project_export(
    app: tauri::AppHandle,
    state: State<'_, ExportState>,
    output_path: String,
    encoder: String,
    width: u32,
    height: u32,
    fps: u32,
) -> Result<(), String> {
    if !matches!(encoder.as_str(), "libx264" | "h264_nvenc") {
        return Err(format!("Unsupported milestone encoder: {encoder}"));
    }
    let supported_size = matches!(
        (width, height),
        (1920, 1080) | (1080, 1920) | (1080, 1080) | (1080, 1350) | (1440, 1080)
    );
    if !supported_size {
        return Err(format!(
            "Unsupported H.264 export resolution: {width}x{height}."
        ));
    }
    if !matches!(fps, 30 | 60) || (fps == 60 && (width, height) != (1920, 1080)) {
        return Err(format!(
            "Unsupported export frame rate: {width}x{height} at {fps} FPS."
        ));
    }
    let frame_bytes = usize::try_from(width)
        .ok()
        .and_then(|value| value.checked_mul(height as usize))
        .and_then(|value| value.checked_mul(4))
        .ok_or("Export frame dimensions overflow the frame buffer size.")?;
    let mut active = state.0.lock().map_err(|_| "Export state lock failed.")?;
    if active.is_some() {
        return Err("A project export is already active.".into());
    }

    let ffmpeg = ffmpeg_resource_path(app)?;
    let video_size = format!("{width}x{height}");
    let frame_rate = fps.to_string();
    let mut child = Command::new(ffmpeg)
        .args([
            "-y",
            "-f",
            "rawvideo",
            "-pixel_format",
            "rgba",
            "-video_size",
            video_size.as_str(),
            "-framerate",
            frame_rate.as_str(),
            "-i",
            "-",
            "-an",
            "-c:v",
            encoder.as_str(),
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            output_path.as_str(),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Unable to start bundled FFmpeg: {error}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or("Unable to open FFmpeg frame stream.")?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or("Unable to capture FFmpeg diagnostics.")?;
    let stderr_reader = std::thread::spawn(move || {
        let mut diagnostics = String::new();
        stderr
            .read_to_string(&mut diagnostics)
            .map_err(|error| format!("Unable to read FFmpeg diagnostics: {error}"))?;
        Ok(diagnostics)
    });
    *active = Some(ExportSession {
        child,
        stdin: Some(stdin),
        stderr_reader,
        output_path: PathBuf::from(output_path),
        frame_bytes,
        frames_written: 0,
    });
    Ok(())
}

#[tauri::command]
fn write_project_export_frame(
    request: tauri::ipc::Request<'_>,
    state: State<'_, ExportState>,
) -> Result<(), String> {
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        InvokeBody::Json(_) => return Err("Project frame must use the raw binary IPC body.".into()),
    };
    let mut active = state.0.lock().map_err(|_| "Export state lock failed.")?;
    let session = active.as_mut().ok_or("No project export is active.")?;
    if bytes.len() != session.frame_bytes {
        return Err(format!(
            "Invalid RGBA frame size: expected {} bytes, received {}.",
            session.frame_bytes,
            bytes.len()
        ));
    }
    session
        .stdin
        .as_mut()
        .ok_or("FFmpeg frame stream is closed.")?
        .write_all(bytes)
        .map_err(|error| format!("FFmpeg frame stream failed: {error}"))?;
    session.frames_written += 1;
    Ok(())
}

#[tauri::command]
fn finish_project_export(state: State<'_, ExportState>) -> Result<ExportResult, String> {
    let mut session = take_export_session(&state)?;
    drop(session.stdin.take());
    let status = session
        .child
        .wait()
        .map_err(|error| format!("Unable to wait for FFmpeg: {error}"))?;
    let diagnostics = join_diagnostics(session.stderr_reader)?;
    if !status.success() {
        let _ = fs::remove_file(&session.output_path);
        return Err(format!(
            "FFmpeg exited with status {status}.\n{}",
            diagnostics.trim()
        ));
    }
    if session.frames_written == 0 {
        let _ = fs::remove_file(&session.output_path);
        return Err("FFmpeg received no project frames.".into());
    }
    Ok(ExportResult {
        frames_written: session.frames_written,
        stderr: diagnostics,
    })
}

#[tauri::command]
fn abort_project_export(state: State<'_, ExportState>) -> Result<(), String> {
    let session = {
        let mut active = state.0.lock().map_err(|_| "Export state lock failed.")?;
        active.take()
    };
    if let Some(mut session) = session {
        drop(session.stdin.take());
        let _ = session.child.kill();
        let _ = session.child.wait();
        let _ = session.stderr_reader.join();
        let _ = fs::remove_file(session.output_path);
    }
    Ok(())
}

fn take_export_session(state: &State<'_, ExportState>) -> Result<ExportSession, String> {
    state
        .0
        .lock()
        .map_err(|_| "Export state lock failed.".to_string())?
        .take()
        .ok_or_else(|| "No project export is active.".to_string())
}

fn join_diagnostics(reader: JoinHandle<Result<String, String>>) -> Result<String, String> {
    reader
        .join()
        .map_err(|_| "FFmpeg diagnostics thread failed.".to_string())?
}

#[tauri::command]
fn render_test_mp4(app: tauri::AppHandle, output_path: String) -> Result<(), String> {
    let ffmpeg = ffmpeg_resource_path(app)?;
    let mut child = Command::new(ffmpeg)
        .args([
            "-y",
            "-f",
            "rawvideo",
            "-pixel_format",
            "rgba",
            "-video_size",
            "1920x1080",
            "-framerate",
            "30",
            "-i",
            "-",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            output_path.as_str(),
        ])
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Unable to start bundled FFmpeg: {error}"))?;
    let frame = vec![18_u8; SMOKE_FRAME_BYTES];
    let stdin = child
        .stdin
        .as_mut()
        .ok_or("Unable to open FFmpeg frame stream.")?;
    for _ in 0..300 {
        stdin
            .write_all(&frame)
            .map_err(|error| format!("FFmpeg frame stream failed: {error}"))?;
    }
    drop(child.stdin.take());
    let status = child
        .wait()
        .map_err(|error| format!("Unable to wait for FFmpeg: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("FFmpeg exited with status {status}."))
    }
}

#[tauri::command]
fn ffmpeg_resource_path(app: tauri::AppHandle) -> Result<String, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let candidates = [
        resource_dir.join("ffmpeg").join("ffmpeg.exe"),
        resource_dir
            .join("resources")
            .join("ffmpeg")
            .join("ffmpeg.exe"),
        resource_dir
            .join("resources")
            .join("resources")
            .join("ffmpeg")
            .join("ffmpeg.exe"),
    ];
    candidates
        .iter()
        .find(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
        .ok_or_else(|| {
            format!(
                "Bundled FFmpeg executable is missing. Checked: {}",
                candidates
                    .iter()
                    .map(|path| path.display().to_string())
                    .collect::<Vec<_>>()
                    .join("; ")
            )
        })
}

#[cfg(test)]
mod portable_project_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_path(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "mapmotion-{label}-{}-{nonce}.mapmotionpack",
            std::process::id()
        ))
    }

    fn write_test_archive(path: &PathBuf, entries: &[(&str, &str)]) {
        let file = File::create(path).expect("create archive");
        let mut archive = ZipWriter::new(file);
        let options = SimpleFileOptions::default().last_modified_time(DateTime::default());
        for (name, contents) in entries {
            archive.start_file(*name, options).expect("start entry");
            archive.write_all(contents.as_bytes()).expect("write entry");
        }
        archive.finish().expect("finish archive");
    }

    #[test]
    fn portable_project_round_trip_preserves_json() {
        let path = test_path("round-trip");
        write_portable_project(
            path.clone(),
            br#"{"packageVersion":1}"#,
            br#"{"version":1}"#,
        )
        .expect("write package");
        let payload = read_portable_project(path.clone()).expect("read package");
        assert_eq!(payload.manifest_json, r#"{"packageVersion":1}"#);
        assert_eq!(payload.project_json, r#"{"version":1}"#);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn portable_project_rejects_missing_entries() {
        let path = test_path("missing-manifest");
        write_test_archive(&path, &[(PORTABLE_PROJECT_PATH, "{}")]);
        let error = read_portable_project(path.clone()).expect_err("missing manifest must fail");
        assert!(error.contains("missing manifest.json"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn portable_project_rejects_traversal_entries() {
        let path = test_path("traversal");
        write_test_archive(
            &path,
            &[
                (PORTABLE_MANIFEST_PATH, "{}"),
                (PORTABLE_PROJECT_PATH, "{}"),
                ("../escape.json", "{}"),
            ],
        );
        let error = read_portable_project(path.clone()).expect_err("traversal must fail");
        assert!(error.contains("unexpected entries") || error.contains("unsafe archive path"));
        let _ = fs::remove_file(path);
    }
}
