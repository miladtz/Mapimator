use std::{io::Write, process::{Command, Stdio}};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![ffmpeg_resource_path, render_test_mp4])
    .run(tauri::generate_context!())
    .expect("error while running MapMotion Studio");
}

#[tauri::command]
fn render_test_mp4(app: tauri::AppHandle, output_path: String) -> Result<(), String> {
  let ffmpeg = ffmpeg_resource_path(app)?;
  let mut child = Command::new(ffmpeg).args(["-y", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "1920x1080", "-framerate", "30", "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p", output_path.as_str()]).stdin(Stdio::piped()).spawn().map_err(|error| format!("Unable to start bundled FFmpeg: {error}"))?;
  let frame = vec![18_u8; 1920 * 1080 * 4];
  let stdin = child.stdin.as_mut().ok_or("Unable to open FFmpeg frame stream.")?;
  for _ in 0..300 { stdin.write_all(&frame).map_err(|error| format!("FFmpeg frame stream failed: {error}"))?; }
  drop(child.stdin.take());
  let status = child.wait().map_err(|error| format!("Unable to wait for FFmpeg: {error}"))?;
  if status.success() { Ok(()) } else { Err(format!("FFmpeg exited with status {status}.")) }
}

#[tauri::command]
fn ffmpeg_resource_path(app: tauri::AppHandle) -> Result<String, String> {
  let resource_dir = app.path().resource_dir().map_err(|error| error.to_string())?;
  let executable = resource_dir.join("resources").join("ffmpeg").join("ffmpeg.exe");
  if !executable.is_file() { return Err("Bundled FFmpeg executable is missing from application resources.".into()); }
  Ok(executable.to_string_lossy().into_owned())
}
