use image::GenericImageView;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::Mutex,
    thread::JoinHandle,
    time::Instant,
};
use tauri::{ipc::InvokeBody, Manager, State};
use zip::{write::SimpleFileOptions, CompressionMethod, DateTime, ZipArchive, ZipWriter};

const SMOKE_FRAME_BYTES: usize = 1920 * 1080 * 4;
const PORTABLE_MANIFEST_PATH: &str = "manifest.json";
const PORTABLE_PROJECT_PATH: &str = "project.json";
const MAX_PORTABLE_JSON_BYTES: u64 = 16 * 1024 * 1024;
const MAX_PROJECT_ASSETS: usize = 128;
const MAX_PROJECT_ASSET_BYTES: u64 = 32 * 1024 * 1024;
const MAX_PROJECT_ASSET_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ZIP_COMPRESSION_RATIO: u64 = 1_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectAsset {
    id: String,
    kind: String,
    filename: String,
    media_type: String,
    sha256: String,
    size: u64,
    width: u32,
    height: u32,
    package_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeManifest {
    package_version: serde_json::Value,
    assets: Option<Vec<ProjectAsset>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedAsset {
    #[serde(flatten)]
    metadata: ProjectAsset,
    bytes: Vec<u8>,
}

#[derive(Serialize)]
struct AssetBytes {
    bytes: Vec<u8>,
}

#[derive(Default)]
struct AssetStoreState(Mutex<()>);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssetStorageIssue {
    code: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    asset_id: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssetStorageDiagnostics {
    stored_assets: usize,
    referenced_assets: usize,
    orphan_metadata: Vec<String>,
    orphan_files: Vec<String>,
    storage_bytes: u64,
    duplicate_payloads: usize,
    hash_failures: usize,
    missing_files: usize,
    integrity_failures: usize,
    issues: Vec<AssetStorageIssue>,
    elapsed_ms: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssetCleanupResult {
    removed: Vec<String>,
    diagnostics: AssetStorageDiagnostics,
}

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
    output_bytes: u64,
    exit_code: i32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectFileWriteResult {
    path: String,
    bytes_written: usize,
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
    assets: Vec<ImportedAsset>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ExportState::default())
        .manage(AssetStoreState::default())
        .invoke_handler(tauri::generate_handler![
            ffmpeg_resource_path,
            render_test_mp4,
            start_project_export,
            write_project_export_frame,
            finish_project_export,
            abort_project_export,
            select_h264_encoder,
            export_portable_project,
            import_portable_project,
            ingest_project_image,
            ingest_project_image_bytes,
            read_project_asset,
            commit_imported_assets,
            scan_project_assets,
            cleanup_project_assets,
            write_project_file,
            read_project_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running MapMotion Studio");
}

#[tauri::command]
fn write_project_file(output_path: String, project_json: String) -> Result<ProjectFileWriteResult, String> {
    serde_json::from_str::<serde_json::Value>(&project_json)
        .map_err(|error| format!("Project serialization is invalid: {error}"))?;
    let path = PathBuf::from(&output_path);
    let parent = path
        .parent()
        .ok_or_else(|| "Project destination has no parent directory.".to_string())?;
    if !parent.is_dir() {
        return Err(format!("Project destination directory does not exist: {}", parent.display()));
    }
    fs::write(&path, project_json.as_bytes())
        .map_err(|error| format!("Unable to write project file '{}': {error}", path.display()))?;
    Ok(ProjectFileWriteResult {
        path: path.to_string_lossy().into_owned(),
        bytes_written: project_json.len(),
    })
}

#[tauri::command]
fn read_project_file(input_path: String) -> Result<String, String> {
    let path = PathBuf::from(&input_path);
    fs::read_to_string(&path)
        .map_err(|error| format!("Unable to read project file '{}': {error}", path.display()))
}

#[tauri::command]
fn export_portable_project(
    app: tauri::AppHandle,
    asset_state: State<'_, AssetStoreState>,
    output_path: String,
    manifest_json: String,
    project_json: String,
    assets: Vec<ProjectAsset>,
) -> Result<(), String> {
    let _guard = asset_state
        .0
        .lock()
        .map_err(|_| "Project asset storage lock failed.")?;
    let stored_assets = assets
        .into_iter()
        .map(|metadata| {
            let bytes = read_stored_asset(&app, &metadata.id)?;
            validate_asset(&metadata, &bytes)?;
            Ok(ImportedAsset { metadata, bytes })
        })
        .collect::<Result<Vec<_>, String>>()?;
    write_portable_project(
        PathBuf::from(output_path),
        manifest_json.as_bytes(),
        project_json.as_bytes(),
        &stored_assets,
    )
}

fn write_portable_project(
    output_path: PathBuf,
    manifest_json: &[u8],
    project_json: &[u8],
    assets: &[ImportedAsset],
) -> Result<(), String> {
    if manifest_json.len() as u64 > MAX_PORTABLE_JSON_BYTES
        || project_json.len() as u64 > MAX_PORTABLE_JSON_BYTES
    {
        return Err("Portable project JSON exceeds the size limit.".into());
    }
    if assets.len() > MAX_PROJECT_ASSETS {
        return Err("Portable project contains too many assets.".into());
    }
    let mut sorted_assets = assets.to_vec();
    sorted_assets
        .sort_by(|left, right| left.metadata.package_path.cmp(&right.metadata.package_path));
    let mut paths = HashSet::new();
    let mut total = 0_u64;
    for asset in &sorted_assets {
        validate_asset(&asset.metadata, &asset.bytes)?;
        if !paths.insert(asset.metadata.package_path.clone()) {
            return Err("Portable project contains duplicate asset package paths.".into());
        }
        total = total
            .checked_add(asset.metadata.size)
            .ok_or("Portable project asset size overflow.")?;
    }
    if total > MAX_PROJECT_ASSET_TOTAL_BYTES {
        return Err("Portable project assets exceed the total size limit.".into());
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
        for asset in &sorted_assets {
            archive
                .start_file(&asset.metadata.package_path, options)
                .map_err(|error| format!("Unable to write portable project asset: {error}"))?;
            archive
                .write_all(&asset.bytes)
                .map_err(|error| format!("Unable to write portable project asset: {error}"))?;
        }
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
    if archive.len() > MAX_PROJECT_ASSETS + 2 {
        return Err("Portable project contains too many entries.".into());
    }
    let mut names = HashSet::new();
    let mut contents = BTreeMap::<String, Vec<u8>>::new();
    let mut total_unpacked = 0_u64;
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
        let name = enclosed.to_string_lossy().replace('\\', "/");
        let valid_shape = matches!(
            name.as_str(),
            PORTABLE_MANIFEST_PATH | PORTABLE_PROJECT_PATH
        ) || (name.starts_with("assets/") && enclosed.components().count() == 2);
        if !valid_shape || entry.is_dir() {
            return Err(format!(
                "Portable project contains an unsupported archive path: {}.",
                entry.name()
            ));
        }
        if !names.insert(name.clone()) {
            return Err(format!(
                "Portable project contains duplicate entry: {name}."
            ));
        }
        let is_json = matches!(
            name.as_str(),
            PORTABLE_MANIFEST_PATH | PORTABLE_PROJECT_PATH
        );
        let limit = if is_json {
            MAX_PORTABLE_JSON_BYTES
        } else {
            MAX_PROJECT_ASSET_BYTES
        };
        if entry.size() > limit {
            return Err(format!("Portable project entry is too large: {name}."));
        }
        if entry.size() > 1024
            && (entry.compressed_size() == 0
                || entry.size() / entry.compressed_size().max(1) > MAX_ZIP_COMPRESSION_RATIO)
        {
            return Err(format!(
                "Portable project entry has an unsafe compression ratio: {name}."
            ));
        }
        total_unpacked = total_unpacked
            .checked_add(entry.size())
            .ok_or("Portable project unpacked size overflow.")?;
        if total_unpacked > MAX_PROJECT_ASSET_TOTAL_BYTES + MAX_PORTABLE_JSON_BYTES * 2 {
            return Err("Portable project exceeds the total unpacked-size limit.".into());
        }
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut bytes)
            .map_err(|error| format!("Unable to read portable project entry: {error}"))?;
        contents.insert(name, bytes);
    }
    let manifest_bytes = contents
        .remove(PORTABLE_MANIFEST_PATH)
        .ok_or("Portable project is missing manifest.json.")?;
    let project_bytes = contents
        .remove(PORTABLE_PROJECT_PATH)
        .ok_or("Portable project is missing project.json.")?;
    let manifest_json = String::from_utf8(manifest_bytes)
        .map_err(|_| "Portable project manifest is not valid UTF-8 JSON text.")?;
    let project_json = String::from_utf8(project_bytes)
        .map_err(|_| "Portable project payload is not valid UTF-8 JSON text.")?;
    let manifest: NativeManifest = serde_json::from_str(&manifest_json)
        .map_err(|error| format!("Portable project asset manifest is malformed: {error}"))?;
    let declarations = match native_version_major(&manifest.package_version) {
        Some(1) => {
            if manifest.assets.is_some() {
                return Err("Milestone 1 packages cannot declare assets.".into());
            }
            Vec::new()
        }
        _ => manifest.assets.unwrap_or_default(),
    };
    if declarations.len() > MAX_PROJECT_ASSETS {
        return Err("Portable project contains too many assets.".into());
    }
    let declared_total = declarations.iter().try_fold(0_u64, |total, asset| {
        total
            .checked_add(asset.size)
            .ok_or("Portable project asset size overflow.")
    })?;
    if declared_total > MAX_PROJECT_ASSET_TOTAL_BYTES {
        return Err("Portable project assets exceed the total size limit.".into());
    }
    let mut asset_ids = HashSet::new();
    let mut declared_paths = HashSet::new();
    let mut imported_assets = Vec::with_capacity(declarations.len());
    let mut asset_total = 0_u64;
    for metadata in declarations {
        validate_asset_metadata(&metadata)?;
        if !declared_paths.insert(metadata.package_path.clone()) {
            return Err(format!(
                "Duplicate asset package path: {}.",
                metadata.package_path
            ));
        }
        if !asset_ids.insert(metadata.id.clone()) {
            return Err(format!("Duplicate project asset ID: {}.", metadata.id));
        }
        let bytes = contents.remove(&metadata.package_path).ok_or_else(|| {
            format!(
                "Portable project asset is missing: {}.",
                metadata.package_path
            )
        })?;
        validate_asset(&metadata, &bytes)?;
        asset_total = asset_total
            .checked_add(metadata.size)
            .ok_or("Portable project asset size overflow.")?;
        imported_assets.push(ImportedAsset { metadata, bytes });
    }
    if asset_total > MAX_PROJECT_ASSET_TOTAL_BYTES {
        return Err("Portable project assets exceed the total size limit.".into());
    }
    if let Some(extra) = contents.keys().next() {
        return Err(format!(
            "Portable project contains unexpected entry: {extra}."
        ));
    }
    Ok(PortableProjectPayload {
        manifest_json,
        project_json,
        assets: imported_assets,
    })
}

fn native_version_major(value: &serde_json::Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str()?.split(['.', '-', '+']).next()?.parse().ok())
}

fn asset_store_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("project-assets"))
        .map_err(|error| format!("Unable to resolve project asset storage: {error}"))
}

fn stored_asset_path(app: &tauri::AppHandle, asset_id: &str) -> Result<PathBuf, String> {
    if !valid_asset_id(asset_id) {
        return Err("Project asset ID is malformed.".into());
    }
    Ok(asset_store_dir(app)?.join(format!("{asset_id}.bin")))
}

fn read_stored_asset(app: &tauri::AppHandle, asset_id: &str) -> Result<Vec<u8>, String> {
    fs::read(stored_asset_path(app, asset_id)?)
        .map_err(|error| format!("Unable to read project asset {asset_id}: {error}"))
}

#[tauri::command]
fn read_project_asset(
    app: tauri::AppHandle,
    asset_state: State<'_, AssetStoreState>,
    asset_id: String,
) -> Result<AssetBytes, String> {
    let _guard = asset_state
        .0
        .lock()
        .map_err(|_| "Project asset storage lock failed.")?;
    Ok(AssetBytes {
        bytes: read_stored_asset(&app, &asset_id)?,
    })
}

#[tauri::command]
fn ingest_project_image(
    app: tauri::AppHandle,
    asset_state: State<'_, AssetStoreState>,
    source_path: String,
) -> Result<ProjectAsset, String> {
    let _guard = asset_state
        .0
        .lock()
        .map_err(|_| "Project asset storage lock failed.")?;
    let source = PathBuf::from(source_path);
    let filename = source
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or("Imported image filename is invalid.")?
        .to_owned();
    let bytes =
        fs::read(&source).map_err(|error| format!("Unable to read imported image: {error}"))?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_PROJECT_ASSET_BYTES {
        return Err("Imported image exceeds the asset size limit.".into());
    }
    let (media_type, extension, width, height) = inspect_image(&bytes)?;
    let sha256 = sha256_hex(&bytes);
    let metadata = ProjectAsset {
        id: format!("asset_{sha256}"),
        kind: "image".into(),
        filename,
        media_type: media_type.into(),
        sha256: sha256.clone(),
        size: bytes.len() as u64,
        width,
        height,
        package_path: format!("assets/{sha256}.{extension}"),
    };
    validate_asset(&metadata, &bytes)?;
    commit_assets(
        &app,
        &[ImportedAsset {
            metadata: metadata.clone(),
            bytes,
        }],
    )?;
    Ok(metadata)
}

/// Ingest image bytes (already decoded to a PNG/JPEG payload, e.g. from a
/// reusable app-level Pin Style) into the project-owned asset store. Uses the
/// exact same content-addressed pipeline as ingest_project_image so project
/// assets remain portable and deduplicated by hash.
#[tauri::command]
fn ingest_project_image_bytes(
    app: tauri::AppHandle,
    asset_state: State<'_, AssetStoreState>,
    bytes: Vec<u8>,
    filename: String,
) -> Result<ProjectAsset, String> {
    let _guard = asset_state
        .0
        .lock()
        .map_err(|_| "Project asset storage lock failed.")?;
    if filename.is_empty() || Path::new(&filename).components().count() != 1 {
        return Err("Imported image filename is invalid.".into());
    }
    if bytes.is_empty() || bytes.len() as u64 > MAX_PROJECT_ASSET_BYTES {
        return Err("Imported image exceeds the asset size limit.".into());
    }
    let (media_type, extension, width, height) = inspect_image(&bytes)?;
    let sha256 = sha256_hex(&bytes);
    let metadata = ProjectAsset {
        id: format!("asset_{sha256}"),
        kind: "image".into(),
        filename,
        media_type: media_type.into(),
        sha256: sha256.clone(),
        size: bytes.len() as u64,
        width,
        height,
        package_path: format!("assets/{sha256}.{extension}"),
    };
    validate_asset(&metadata, &bytes)?;
    commit_assets(
        &app,
        &[ImportedAsset {
            metadata: metadata.clone(),
            bytes,
        }],
    )?;
    Ok(metadata)
}

#[tauri::command]
fn commit_imported_assets(
    app: tauri::AppHandle,
    asset_state: State<'_, AssetStoreState>,
    assets: Vec<ImportedAsset>,
) -> Result<(), String> {
    let _guard = asset_state
        .0
        .lock()
        .map_err(|_| "Project asset storage lock failed.")?;
    commit_assets(&app, &assets)
}

fn commit_assets(app: &tauri::AppHandle, assets: &[ImportedAsset]) -> Result<(), String> {
    if assets.len() > MAX_PROJECT_ASSETS {
        return Err("Too many imported project assets.".into());
    }
    let mut total = 0_u64;
    let mut ids = HashSet::new();
    for asset in assets {
        validate_asset(&asset.metadata, &asset.bytes)?;
        if !ids.insert(asset.metadata.id.clone()) {
            return Err(format!(
                "Duplicate imported project asset ID: {}.",
                asset.metadata.id
            ));
        }
        total = total
            .checked_add(asset.metadata.size)
            .ok_or("Imported project asset size overflow.")?;
    }
    if total > MAX_PROJECT_ASSET_TOTAL_BYTES {
        return Err("Imported project assets exceed the total size limit.".into());
    }
    let directory = asset_store_dir(app)?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Unable to create project asset storage: {error}"))?;
    let mut staged = Vec::new();
    for asset in assets {
        let target = stored_asset_path(app, &asset.metadata.id)?;
        if target.exists() {
            let existing = fs::read(&target)
                .map_err(|error| format!("Unable to verify stored project asset: {error}"))?;
            if sha256_hex(&existing) != asset.metadata.sha256 {
                return Err(format!(
                    "Stored project asset conflicts with {}.",
                    asset.metadata.id
                ));
            }
            continue;
        }
        let temporary =
            directory.join(format!(".{}.{}.tmp", asset.metadata.id, std::process::id()));
        if let Err(error) = fs::write(&temporary, &asset.bytes) {
            for (path, _) in &staged {
                let _ = fs::remove_file(path);
            }
            return Err(format!("Unable to stage imported project asset: {error}"));
        }
        staged.push((temporary, target));
    }
    let mut committed = Vec::new();
    for (temporary, target) in &staged {
        if let Err(error) = fs::rename(temporary, target) {
            for path in committed {
                let _ = fs::remove_file(path);
            }
            for (path, _) in &staged {
                let _ = fs::remove_file(path);
            }
            return Err(format!("Unable to commit imported project assets: {error}"));
        }
        committed.push(target.clone());
    }
    Ok(())
}

#[tauri::command]
fn scan_project_assets(
    app: tauri::AppHandle,
    asset_state: State<'_, AssetStoreState>,
    assets: Vec<ProjectAsset>,
    referenced_ids: Vec<String>,
) -> Result<AssetStorageDiagnostics, String> {
    let _guard = asset_state
        .0
        .lock()
        .map_err(|_| "Project asset storage lock failed.")?;
    scan_asset_storage(&asset_store_dir(&app)?, &assets, &referenced_ids)
}

#[tauri::command]
fn cleanup_project_assets(
    app: tauri::AppHandle,
    asset_state: State<'_, AssetStoreState>,
    assets: Vec<ProjectAsset>,
    referenced_ids: Vec<String>,
) -> Result<AssetCleanupResult, String> {
    let _guard = asset_state
        .0
        .lock()
        .map_err(|_| "Project asset storage lock failed.")?;
    cleanup_asset_storage(&asset_store_dir(&app)?, &assets, &referenced_ids, None)
}

fn storage_issue(
    diagnostics: &mut AssetStorageDiagnostics,
    code: &str,
    asset_id: Option<&str>,
    message: String,
) {
    diagnostics.integrity_failures += 1;
    diagnostics.issues.push(AssetStorageIssue {
        code: code.into(),
        message,
        asset_id: asset_id.map(str::to_owned),
    });
}

fn scan_asset_storage(
    directory: &Path,
    assets: &[ProjectAsset],
    referenced_ids: &[String],
) -> Result<AssetStorageDiagnostics, String> {
    let started = Instant::now();
    let referenced = referenced_ids.iter().cloned().collect::<HashSet<_>>();
    let mut diagnostics = AssetStorageDiagnostics {
        referenced_assets: referenced.len(),
        ..AssetStorageDiagnostics::default()
    };
    let mut metadata = HashMap::<String, &ProjectAsset>::new();
    let mut metadata_hashes = HashMap::<String, String>::new();
    for asset in assets {
        if metadata.insert(asset.id.clone(), asset).is_some() {
            storage_issue(
                &mut diagnostics,
                "duplicate_metadata",
                Some(&asset.id),
                format!("Duplicate project asset metadata: {}.", asset.id),
            );
        }
        if let Some(previous) = metadata_hashes.insert(asset.sha256.clone(), asset.id.clone()) {
            if previous != asset.id {
                storage_issue(
                    &mut diagnostics,
                    "duplicate_hash",
                    Some(&asset.id),
                    format!(
                        "Project assets {previous} and {} declare the same payload hash.",
                        asset.id
                    ),
                );
            }
        }
        if let Err(error) = validate_asset_metadata(asset) {
            storage_issue(&mut diagnostics, "invalid_metadata", Some(&asset.id), error);
        }
        if !referenced.contains(&asset.id) {
            diagnostics.orphan_metadata.push(asset.id.clone());
        }
    }
    for asset_id in &referenced {
        if !metadata.contains_key(asset_id) {
            storage_issue(
                &mut diagnostics,
                "missing_metadata",
                Some(asset_id),
                format!("Referenced project asset has no metadata: {asset_id}."),
            );
        }
    }

    let mut stored_ids = HashSet::new();
    let mut payload_paths = HashMap::<String, String>::new();
    if directory.is_dir() {
        let entries = fs::read_dir(directory)
            .map_err(|error| format!("Unable to scan project asset storage: {error}"))?;
        for entry in entries {
            let entry = entry
                .map_err(|error| format!("Unable to inspect project asset storage: {error}"))?;
            let file_type = entry
                .file_type()
                .map_err(|error| format!("Unable to inspect project asset file: {error}"))?;
            if !file_type.is_file() {
                continue;
            }
            let filename = entry.file_name().to_string_lossy().into_owned();
            let Some(asset_id) = filename
                .strip_suffix(".bin")
                .filter(|id| valid_asset_id(id))
            else {
                diagnostics.orphan_files.push(filename);
                continue;
            };
            diagnostics.stored_assets += 1;
            stored_ids.insert(asset_id.to_owned());
            let bytes = match fs::read(entry.path()) {
                Ok(bytes) => bytes,
                Err(error) => {
                    storage_issue(
                        &mut diagnostics,
                        "read_failure",
                        Some(asset_id),
                        format!("Unable to read stored project asset {asset_id}: {error}"),
                    );
                    continue;
                }
            };
            diagnostics.storage_bytes =
                diagnostics.storage_bytes.saturating_add(bytes.len() as u64);
            let actual_hash = sha256_hex(&bytes);
            if let Some(previous) = payload_paths.insert(actual_hash.clone(), asset_id.to_owned()) {
                if previous != asset_id {
                    diagnostics.duplicate_payloads += 1;
                    storage_issue(
                        &mut diagnostics,
                        "duplicate_payload",
                        Some(asset_id),
                        format!("Stored assets {previous} and {asset_id} contain duplicate payload bytes."),
                    );
                }
            }
            if asset_id != format!("asset_{actual_hash}") {
                diagnostics.hash_failures += 1;
                storage_issue(
                    &mut diagnostics,
                    "filename_hash_mismatch",
                    Some(asset_id),
                    format!(
                        "Stored asset filename does not match its SHA-256 payload: {asset_id}."
                    ),
                );
            }
            if let Some(asset) = metadata.get(asset_id) {
                if bytes.len() as u64 != asset.size {
                    storage_issue(
                        &mut diagnostics,
                        "size_mismatch",
                        Some(asset_id),
                        format!("Stored project asset size mismatch: {asset_id}."),
                    );
                }
                if actual_hash != asset.sha256 {
                    diagnostics.hash_failures += 1;
                    storage_issue(
                        &mut diagnostics,
                        "hash_mismatch",
                        Some(asset_id),
                        format!("Stored project asset hash mismatch: {asset_id}."),
                    );
                }
                match inspect_image(&bytes) {
                    Ok((media_type, _, width, height)) => {
                        if media_type != asset.media_type
                            || width != asset.width
                            || height != asset.height
                        {
                            storage_issue(
                                &mut diagnostics,
                                "image_metadata_mismatch",
                                Some(asset_id),
                                format!("Stored project image metadata mismatch: {asset_id}."),
                            );
                        }
                    }
                    Err(error) => storage_issue(
                        &mut diagnostics,
                        "image_decode_failure",
                        Some(asset_id),
                        format!("Stored project image {asset_id} is not decodable: {error}"),
                    ),
                }
            } else {
                diagnostics.orphan_files.push(filename);
            }
        }
    }
    for asset in assets {
        if !stored_ids.contains(&asset.id) {
            diagnostics.missing_files += 1;
            storage_issue(
                &mut diagnostics,
                "missing_file",
                Some(&asset.id),
                format!("Stored project asset file is missing: {}.", asset.id),
            );
        }
    }
    diagnostics.orphan_metadata.sort();
    diagnostics.orphan_metadata.dedup();
    diagnostics.orphan_files.sort();
    diagnostics.orphan_files.dedup();
    diagnostics.elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
    Ok(diagnostics)
}

fn cleanup_asset_storage(
    directory: &Path,
    live_assets: &[ProjectAsset],
    referenced_ids: &[String],
    fail_after: Option<usize>,
) -> Result<AssetCleanupResult, String> {
    let referenced = referenced_ids.iter().cloned().collect::<HashSet<_>>();
    let mut removed = Vec::new();
    if directory.is_dir() {
        let mut entries = fs::read_dir(directory)
            .map_err(|error| format!("Unable to scan project asset storage for cleanup: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| {
                format!("Unable to inspect project asset storage for cleanup: {error}")
            })?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if !entry
                .file_type()
                .map_err(|error| format!("Unable to inspect cleanup candidate: {error}"))?
                .is_file()
            {
                continue;
            }
            let filename = entry.file_name().to_string_lossy().into_owned();
            let asset_id = filename
                .strip_suffix(".bin")
                .filter(|id| valid_asset_id(id));
            let is_stale_temp = filename.starts_with('.') && filename.ends_with(".tmp");
            let removable = asset_id.is_some_and(|id| !referenced.contains(id)) || is_stale_temp;
            if !removable {
                continue;
            }
            if fail_after.is_some_and(|limit| removed.len() >= limit) {
                return Err("Simulated interruption during project asset cleanup.".into());
            }
            fs::remove_file(entry.path()).map_err(|error| {
                format!("Unable to remove orphan project asset {filename}: {error}")
            })?;
            removed.push(asset_id.unwrap_or(&filename).to_owned());
        }
    }
    let diagnostics = scan_asset_storage(directory, live_assets, referenced_ids)?;
    Ok(AssetCleanupResult {
        removed,
        diagnostics,
    })
}

fn valid_asset_id(value: &str) -> bool {
    value.len() == 70
        && value.starts_with("asset_")
        && value[6..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn validate_asset_metadata(asset: &ProjectAsset) -> Result<(), String> {
    if !valid_asset_id(&asset.id)
        || asset.sha256.len() != 64
        || !asset
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || asset.id != format!("asset_{}", asset.sha256)
    {
        return Err("Project asset identity metadata is malformed.".into());
    }
    if asset.kind != "image" {
        return Err(format!("Unsupported project asset kind: {}.", asset.kind));
    }
    if asset.filename.is_empty() || Path::new(&asset.filename).components().count() != 1 {
        return Err("Project asset filename is malformed.".into());
    }
    if asset.size == 0 || asset.size > MAX_PROJECT_ASSET_BYTES {
        return Err("Project asset exceeds the per-asset size limit.".into());
    }
    if asset.width == 0 || asset.height == 0 {
        return Err("Project image dimensions are malformed.".into());
    }
    let extension = if asset.media_type == "image/png" {
        "png"
    } else if asset.media_type == "image/jpeg" {
        "jpg"
    } else {
        return Err(format!(
            "Unsupported project image media type: {}.",
            asset.media_type
        ));
    };
    if asset.package_path != format!("assets/{}.{}", asset.sha256, extension) {
        return Err("Project asset package path is unsafe or inconsistent.".into());
    }
    Ok(())
}

fn validate_asset(asset: &ProjectAsset, bytes: &[u8]) -> Result<(), String> {
    validate_asset_metadata(asset)?;
    if bytes.len() as u64 != asset.size {
        return Err(format!("Project asset size mismatch: {}.", asset.id));
    }
    if sha256_hex(bytes) != asset.sha256 {
        return Err(format!("Project asset hash mismatch: {}.", asset.id));
    }
    let (media_type, _, width, height) = inspect_image(bytes)?;
    if media_type != asset.media_type || width != asset.width || height != asset.height {
        return Err(format!("Project image metadata mismatch: {}.", asset.id));
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn inspect_image(bytes: &[u8]) -> Result<(&'static str, &'static str, u32, u32), String> {
    let (format, media_type, extension) = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        (image::ImageFormat::Png, "image/png", "png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        (image::ImageFormat::Jpeg, "image/jpeg", "jpg")
    } else {
        return Err("Imported project asset is not a supported PNG or JPEG image.".into());
    };
    let image = image::load_from_memory_with_format(bytes, format)
        .map_err(|error| format!("Imported project image is malformed: {error}"))?;
    let (width, height) = image.dimensions();
    Ok((media_type, extension, width, height))
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
    let output = PathBuf::from(&output_path);
    let parent = output
        .parent()
        .ok_or_else(|| "Video destination has no parent directory.".to_string())?;
    if !parent.is_dir() {
        return Err(format!("Video destination directory does not exist: {}", parent.display()));
    }
    if output.extension().and_then(|value| value.to_str()).map(str::to_ascii_lowercase).as_deref()
        != Some("mp4")
    {
        return Err("Video destination must use the .mp4 extension.".into());
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
    let mut command = Command::new(ffmpeg);
    command.args([
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
    ]);
    command.args(match encoder.as_str() {
        "h264_nvenc" => [
            "-preset", "p6", "-tune", "hq", "-rc", "vbr", "-cq", "17", "-b:v", "0",
        ]
        .as_slice(),
        "libx264" => ["-preset", "slow", "-crf", "17"].as_slice(),
        _ => unreachable!("encoder was validated above"),
    });
    let mut child = command
        .args([
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
    let write_error = session
        .stdin
        .as_mut()
        .ok_or("FFmpeg frame stream is closed.")?
        .write_all(bytes)
        .err();
    if write_error.is_none() {
        session.frames_written += 1;
        return Ok(());
    }
    let mut failed = active.take().ok_or("No project export is active.")?;
    drop(active);
    drop(failed.stdin.take());
    let status = failed.child.wait().ok();
    let diagnostics = join_diagnostics(failed.stderr_reader).unwrap_or_default();
    let _ = fs::remove_file(&failed.output_path);
    Err(format!(
        "FFmpeg frame stream failed after {} frames: {}. Exit status: {}.\n{}",
        failed.frames_written,
        write_error.expect("write error checked"),
        status
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unavailable".into()),
        diagnostics.trim()
    ))
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
    let output_bytes = fs::metadata(&session.output_path)
        .map_err(|error| format!("FFmpeg completed but output is missing: {error}"))?
        .len();
    if output_bytes == 0 {
        let _ = fs::remove_file(&session.output_path);
        return Err("FFmpeg completed but produced an empty output file.".into());
    }
    Ok(ExportResult {
        frames_written: session.frames_written,
        stderr: diagnostics,
        output_bytes,
        exit_code: status.code().unwrap_or(0),
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
    use std::io::Cursor;
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

    fn write_binary_archive(path: &PathBuf, entries: &[(&str, &[u8])]) {
        let file = File::create(path).expect("create archive");
        let mut archive = ZipWriter::new(file);
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .last_modified_time(DateTime::default());
        for (name, contents) in entries {
            archive.start_file(*name, options).expect("start entry");
            archive.write_all(contents).expect("write entry");
        }
        archive.finish().expect("finish archive");
    }

    #[test]
    fn project_file_native_round_trip_and_invalid_json_rejection() {
        let path = test_path("project-file").with_extension("mapmotion");
        let json = r#"{"version":1,"name":"native-save"}"#.to_string();
        let result = write_project_file(path.to_string_lossy().into_owned(), json.clone())
            .expect("write project file");
        assert_eq!(result.bytes_written, json.len());
        assert_eq!(read_project_file(result.path).expect("read project file"), json);
        fs::remove_file(&path).expect("remove project file");

        let invalid = test_path("invalid-project").with_extension("mapmotion");
        assert!(write_project_file(invalid.to_string_lossy().into_owned(), "{broken".into())
            .expect_err("invalid JSON must fail")
            .contains("Project serialization is invalid"));
        assert!(!invalid.exists());
    }

    fn image_fixture() -> (ProjectAsset, Vec<u8>) {
        let mut cursor = Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(2, 2)
            .write_to(&mut cursor, image::ImageFormat::Png)
            .expect("encode png");
        let bytes = cursor.into_inner();
        let sha256 = sha256_hex(&bytes);
        (
            ProjectAsset {
                id: format!("asset_{sha256}"),
                kind: "image".into(),
                filename: "fixture.png".into(),
                media_type: "image/png".into(),
                sha256: sha256.clone(),
                size: bytes.len() as u64,
                width: 2,
                height: 2,
                package_path: format!("assets/{sha256}.png"),
            },
            bytes,
        )
    }

    fn image_fixture_with_color(value: u8) -> (ProjectAsset, Vec<u8>) {
        let image = image::RgbaImage::from_pixel(
            2,
            2,
            image::Rgba([value, value.wrapping_mul(3), 255, 255]),
        );
        let mut cursor = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut cursor, image::ImageFormat::Png)
            .expect("encode png");
        let bytes = cursor.into_inner();
        let sha256 = sha256_hex(&bytes);
        (
            ProjectAsset {
                id: format!("asset_{sha256}"),
                kind: "image".into(),
                filename: format!("fixture-{value}.png"),
                media_type: "image/png".into(),
                sha256: sha256.clone(),
                size: bytes.len() as u64,
                width: 2,
                height: 2,
                package_path: format!("assets/{sha256}.png"),
            },
            bytes,
        )
    }

    fn test_store(label: &str) -> PathBuf {
        let directory = test_path(label).with_extension("store");
        fs::create_dir_all(&directory).expect("create test store");
        directory
    }

    fn store_fixture(directory: &Path, asset: &ProjectAsset, bytes: &[u8]) {
        fs::write(directory.join(format!("{}.bin", asset.id)), bytes)
            .expect("write stored fixture");
    }

    fn manifest_json(assets: serde_json::Value) -> String {
        serde_json::json!({
            "format": "mapmotion-portable-project",
            "packageVersion": "2.0.0",
            "projectSchemaVersion": "1.0.0",
            "projectName": "Asset test",
            "requiredDataPackages": [],
            "contents": { "manifest": "manifest.json", "project": "project.json" },
            "assets": assets,
        })
        .to_string()
    }

    #[test]
    fn portable_project_round_trip_preserves_json() {
        let path = test_path("round-trip");
        write_portable_project(
            path.clone(),
            br#"{"packageVersion":1}"#,
            br#"{"version":1}"#,
            &[],
        )
        .expect("write package");
        let payload = read_portable_project(path.clone()).expect("read package");
        assert_eq!(payload.manifest_json, r#"{"packageVersion":1}"#);
        assert_eq!(payload.project_json, r#"{"version":1}"#);
        assert!(payload.assets.is_empty());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn portable_project_output_is_deterministic() {
        let first = test_path("deterministic-first");
        let second = test_path("deterministic-second");
        write_portable_project(
            first.clone(),
            br#"{"packageVersion":1}"#,
            br#"{"version":1}"#,
            &[],
        )
        .expect("write first package");
        write_portable_project(
            second.clone(),
            br#"{"packageVersion":1}"#,
            br#"{"version":1}"#,
            &[],
        )
        .expect("write second package");
        assert_eq!(
            fs::read(&first).expect("read first"),
            fs::read(&second).expect("read second")
        );
        let _ = fs::remove_file(first);
        let _ = fs::remove_file(second);
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

    #[test]
    fn portable_project_asset_output_is_deterministic_and_validated() {
        let (metadata, bytes) = image_fixture();
        let asset = ImportedAsset {
            metadata: metadata.clone(),
            bytes,
        };
        let manifest = manifest_json(serde_json::json!([metadata]));
        let first = test_path("asset-deterministic-first");
        let second = test_path("asset-deterministic-second");
        write_portable_project(first.clone(), manifest.as_bytes(), b"{}", &[asset.clone()])
            .expect("write first");
        write_portable_project(second.clone(), manifest.as_bytes(), b"{}", &[asset])
            .expect("write second");
        assert_eq!(fs::read(&first).unwrap(), fs::read(&second).unwrap());
        assert_eq!(
            read_portable_project(first.clone()).unwrap().assets.len(),
            1
        );
        let _ = fs::remove_file(first);
        let _ = fs::remove_file(second);
    }

    #[test]
    fn portable_project_rejects_missing_and_hash_mismatched_assets() {
        let (metadata, bytes) = image_fixture();
        let manifest = manifest_json(serde_json::json!([metadata.clone()]));
        let missing = test_path("asset-missing");
        write_binary_archive(
            &missing,
            &[
                (PORTABLE_MANIFEST_PATH, manifest.as_bytes()),
                (PORTABLE_PROJECT_PATH, b"{}"),
            ],
        );
        assert!(read_portable_project(missing.clone())
            .unwrap_err()
            .contains("missing"));
        let corrupt = test_path("asset-corrupt");
        let mut corrupt_bytes = bytes;
        let last = corrupt_bytes.len() - 1;
        corrupt_bytes[last] ^= 1;
        write_binary_archive(
            &corrupt,
            &[
                (PORTABLE_MANIFEST_PATH, manifest.as_bytes()),
                (PORTABLE_PROJECT_PATH, b"{}"),
                (&metadata.package_path, &corrupt_bytes),
            ],
        );
        assert!(read_portable_project(corrupt.clone())
            .unwrap_err()
            .contains("hash mismatch"));
        let _ = fs::remove_file(missing);
        let _ = fs::remove_file(corrupt);
    }

    #[test]
    fn portable_project_rejects_duplicate_and_unsafe_asset_paths() {
        let (metadata, bytes) = image_fixture();
        let duplicate_manifest =
            manifest_json(serde_json::json!([metadata.clone(), metadata.clone()]));
        let duplicate = test_path("asset-duplicate");
        write_binary_archive(
            &duplicate,
            &[
                (PORTABLE_MANIFEST_PATH, duplicate_manifest.as_bytes()),
                (PORTABLE_PROJECT_PATH, b"{}"),
                (&metadata.package_path, &bytes),
            ],
        );
        assert!(read_portable_project(duplicate.clone())
            .unwrap_err()
            .contains("Duplicate asset package path"));
        let mut unsafe_metadata = metadata.clone();
        unsafe_metadata.package_path = "assets/../escape.png".into();
        let unsafe_manifest = manifest_json(serde_json::json!([unsafe_metadata]));
        let unsafe_path = test_path("asset-unsafe");
        write_binary_archive(
            &unsafe_path,
            &[
                (PORTABLE_MANIFEST_PATH, unsafe_manifest.as_bytes()),
                (PORTABLE_PROJECT_PATH, b"{}"),
                (&metadata.package_path, &bytes),
            ],
        );
        assert!(read_portable_project(unsafe_path.clone())
            .unwrap_err()
            .contains("unsafe or inconsistent"));
        let _ = fs::remove_file(duplicate);
        let _ = fs::remove_file(unsafe_path);
    }

    #[test]
    fn portable_project_rejects_malformed_unsupported_and_oversized_metadata() {
        let (metadata, _) = image_fixture();
        let malformed = test_path("asset-malformed");
        let malformed_manifest = manifest_json(serde_json::json!([{ "id": 7 }]));
        write_binary_archive(
            &malformed,
            &[
                (PORTABLE_MANIFEST_PATH, malformed_manifest.as_bytes()),
                (PORTABLE_PROJECT_PATH, b"{}"),
            ],
        );
        assert!(read_portable_project(malformed.clone())
            .unwrap_err()
            .contains("malformed"));
        let mut unsupported_metadata = metadata.clone();
        unsupported_metadata.kind = "executable".into();
        let unsupported = test_path("asset-unsupported");
        let unsupported_manifest = manifest_json(serde_json::json!([unsupported_metadata]));
        write_binary_archive(
            &unsupported,
            &[
                (PORTABLE_MANIFEST_PATH, unsupported_manifest.as_bytes()),
                (PORTABLE_PROJECT_PATH, b"{}"),
            ],
        );
        assert!(read_portable_project(unsupported.clone())
            .unwrap_err()
            .contains("Unsupported project asset kind"));
        let mut oversized_metadata = metadata;
        oversized_metadata.size = MAX_PROJECT_ASSET_BYTES + 1;
        let oversized = test_path("asset-oversized");
        let oversized_manifest = manifest_json(serde_json::json!([oversized_metadata]));
        write_binary_archive(
            &oversized,
            &[
                (PORTABLE_MANIFEST_PATH, oversized_manifest.as_bytes()),
                (PORTABLE_PROJECT_PATH, b"{}"),
            ],
        );
        assert!(read_portable_project(oversized.clone())
            .unwrap_err()
            .contains("per-asset size limit"));
        let _ = fs::remove_file(malformed);
        let _ = fs::remove_file(unsupported);
        let _ = fs::remove_file(oversized);
    }

    #[test]
    fn portable_project_rejects_total_size_limit_and_extreme_compression() {
        let (metadata, _) = image_fixture();
        let declarations = (0..3)
            .map(|index| {
                let sha = format!("{:064x}", index + 1);
                ProjectAsset {
                    id: format!("asset_{sha}"),
                    sha256: sha.clone(),
                    package_path: format!("assets/{sha}.png"),
                    size: MAX_PROJECT_ASSET_BYTES,
                    ..metadata.clone()
                }
            })
            .collect::<Vec<_>>();
        let total = test_path("asset-total-limit");
        let total_manifest = manifest_json(serde_json::json!(declarations));
        write_binary_archive(
            &total,
            &[
                (PORTABLE_MANIFEST_PATH, total_manifest.as_bytes()),
                (PORTABLE_PROJECT_PATH, b"{}"),
            ],
        );
        assert!(read_portable_project(total.clone())
            .unwrap_err()
            .contains("total size limit"));

        let compressed = test_path("asset-compression-ratio");
        let zeros = vec![0_u8; 8 * 1024 * 1024];
        write_binary_archive(
            &compressed,
            &[
                (PORTABLE_MANIFEST_PATH, b"{}"),
                (PORTABLE_PROJECT_PATH, b"{}"),
                ("assets/zeros.png", &zeros),
            ],
        );
        assert!(read_portable_project(compressed.clone())
            .unwrap_err()
            .contains("compression ratio"));
        let _ = fs::remove_file(total);
        let _ = fs::remove_file(compressed);
    }

    #[test]
    fn asset_storage_reports_missing_orphan_and_duplicate_metadata() {
        let directory = test_store("storage-diagnostics");
        let (asset, bytes) = image_fixture();
        let missing =
            scan_asset_storage(&directory, &[asset.clone()], &[asset.id.clone()]).unwrap();
        assert_eq!(missing.missing_files, 1);
        assert!(missing
            .issues
            .iter()
            .any(|issue| issue.code == "missing_file"));

        store_fixture(&directory, &asset, &bytes);
        let orphan_file = scan_asset_storage(&directory, &[], &[]).unwrap();
        assert_eq!(orphan_file.orphan_files, vec![format!("{}.bin", asset.id)]);
        let orphan_metadata = scan_asset_storage(&directory, &[asset.clone()], &[]).unwrap();
        assert_eq!(orphan_metadata.orphan_metadata, vec![asset.id.clone()]);
        let duplicate = scan_asset_storage(
            &directory,
            &[asset.clone(), asset.clone()],
            &[asset.id.clone()],
        )
        .unwrap();
        assert!(duplicate
            .issues
            .iter()
            .any(|issue| issue.code == "duplicate_metadata"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn asset_storage_reports_payload_hash_size_and_media_corruption() {
        let directory = test_store("storage-corruption");
        let (asset, bytes) = image_fixture();
        store_fixture(&directory, &asset, &bytes);
        let fake_id = format!("asset_{}", "0".repeat(64));
        fs::write(directory.join(format!("{fake_id}.bin")), &bytes).unwrap();
        let duplicate_payload =
            scan_asset_storage(&directory, &[asset.clone()], &[asset.id.clone()]).unwrap();
        assert_eq!(duplicate_payload.duplicate_payloads, 1);
        assert!(duplicate_payload.hash_failures >= 1);

        let mut wrong_size = asset.clone();
        wrong_size.size += 1;
        let size = scan_asset_storage(&directory, &[wrong_size], &[asset.id.clone()]).unwrap();
        assert!(size
            .issues
            .iter()
            .any(|issue| issue.code == "size_mismatch"));

        let mut wrong_media = asset.clone();
        wrong_media.media_type = "image/jpeg".into();
        wrong_media.package_path = format!("assets/{}.jpg", wrong_media.sha256);
        let media = scan_asset_storage(&directory, &[wrong_media], &[asset.id.clone()]).unwrap();
        assert!(media
            .issues
            .iter()
            .any(|issue| issue.code == "image_metadata_mismatch"));

        let mut corrupt = bytes;
        corrupt[20] ^= 1;
        store_fixture(&directory, &asset, &corrupt);
        let hash = scan_asset_storage(&directory, &[asset.clone()], &[asset.id.clone()]).unwrap();
        assert!(hash.hash_failures >= 1);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn asset_cleanup_is_interruption_safe_idempotent_and_preserves_references() {
        let directory = test_store("storage-cleanup");
        let (live, live_bytes) = image_fixture_with_color(1);
        let (orphan_a, orphan_a_bytes) = image_fixture_with_color(2);
        let (orphan_b, orphan_b_bytes) = image_fixture_with_color(3);
        store_fixture(&directory, &live, &live_bytes);
        store_fixture(&directory, &orphan_a, &orphan_a_bytes);
        store_fixture(&directory, &orphan_b, &orphan_b_bytes);
        let live_ids = vec![live.id.clone(), live.id.clone(), live.id.clone()];

        let interrupted = cleanup_asset_storage(&directory, &[live.clone()], &live_ids, Some(1));
        assert!(interrupted.unwrap_err().contains("Simulated interruption"));
        assert!(directory.join(format!("{}.bin", live.id)).is_file());

        let first = cleanup_asset_storage(&directory, &[live.clone()], &live_ids, None).unwrap();
        assert!(directory.join(format!("{}.bin", live.id)).is_file());
        assert_eq!(first.diagnostics.stored_assets, 1);
        assert_eq!(first.diagnostics.referenced_assets, 1);
        let second = cleanup_asset_storage(&directory, &[live.clone()], &live_ids, None).unwrap();
        assert!(second.removed.is_empty());
        assert_eq!(second.diagnostics.integrity_failures, 0);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn asset_storage_scans_and_cleans_one_hundred_objects() {
        let directory = test_store("storage-performance");
        let mut live_assets = Vec::new();
        let mut live_ids = Vec::new();
        for value in 0..100_u8 {
            let (asset, bytes) = image_fixture_with_color(value);
            store_fixture(&directory, &asset, &bytes);
            if value < 80 {
                live_ids.push(asset.id.clone());
                live_assets.push(asset);
            }
        }
        let scan_started = Instant::now();
        let scan = scan_asset_storage(&directory, &live_assets, &live_ids).unwrap();
        let scan_wall_ms = scan_started.elapsed().as_secs_f64() * 1_000.0;
        assert_eq!(scan.stored_assets, 100);
        assert_eq!(scan.orphan_files.len(), 20);
        let cleanup_started = Instant::now();
        let cleanup = cleanup_asset_storage(&directory, &live_assets, &live_ids, None).unwrap();
        let cleanup_wall_ms = cleanup_started.elapsed().as_secs_f64() * 1_000.0;
        assert_eq!(cleanup.removed.len(), 20);
        assert_eq!(cleanup.diagnostics.stored_assets, 80);
        assert_eq!(cleanup.diagnostics.integrity_failures, 0);
        assert!(
            scan_wall_ms < 5_000.0,
            "100-asset scan took {scan_wall_ms:.2} ms"
        );
        assert!(
            cleanup_wall_ms < 5_000.0,
            "100-asset cleanup took {cleanup_wall_ms:.2} ms"
        );
        eprintln!("100-asset scan: {scan_wall_ms:.2} ms; cleanup: {cleanup_wall_ms:.2} ms");
        fs::remove_dir_all(directory).unwrap();
    }
}
