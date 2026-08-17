#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![ffmpeg_resource_path])
    .run(tauri::generate_context!())
    .expect("error while running MapMotion Studio");
}

#[tauri::command]
fn ffmpeg_resource_path(app: tauri::AppHandle) -> Result<String, String> {
  let resource_dir = app.path().resource_dir().map_err(|error| error.to_string())?;
  let executable = resource_dir.join("resources").join("ffmpeg").join("ffmpeg.exe");
  if !executable.is_file() { return Err("Bundled FFmpeg executable is missing from application resources.".into()); }
  Ok(executable.to_string_lossy().into_owned())
}
use tauri::Manager;
