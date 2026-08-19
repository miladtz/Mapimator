use serde::Serialize;
use std::{
    fs,
    io::{Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::Mutex,
    thread::JoinHandle,
};
use tauri::{ipc::InvokeBody, Manager, State};

const FRAME_BYTES: usize = 1920 * 1080 * 4;

#[derive(Default)]
struct ExportState(Mutex<Option<ExportSession>>);

struct ExportSession {
    child: Child,
    stdin: Option<ChildStdin>,
    stderr_reader: JoinHandle<Result<String, String>>,
    output_path: PathBuf,
    frames_written: usize,
}

#[derive(Serialize)]
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
            select_h264_encoder
        ])
        .run(tauri::generate_context!())
        .expect("error while running MapMotion Studio");
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
) -> Result<(), String> {
    if !matches!(encoder.as_str(), "libx264" | "h264_nvenc") {
        return Err(format!("Unsupported milestone encoder: {encoder}"));
    }
    let mut active = state.0.lock().map_err(|_| "Export state lock failed.")?;
    if active.is_some() {
        return Err("A project export is already active.".into());
    }

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
    if bytes.len() != FRAME_BYTES {
        return Err(format!(
            "Invalid RGBA frame size: expected {FRAME_BYTES} bytes, received {}.",
            bytes.len()
        ));
    }
    let mut active = state.0.lock().map_err(|_| "Export state lock failed.")?;
    let session = active.as_mut().ok_or("No project export is active.")?;
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
    let frame = vec![18_u8; FRAME_BYTES];
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
