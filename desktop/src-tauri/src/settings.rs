//! What the app remembers between launches besides its plans: where the user
//! said MKVToolNix and FFmpeg are, when they chose by hand (`tools.json`), and
//! whether fixing changes the original files instead of making copies, and
//! whether such a fix keeps each file's date (`settings.json`).
//!
//! Each is a small JSON file in the app's config directory. The
//! window has no file access of its own, so reading and writing it happen
//! here. Nothing in it is trusted: the engine checks every path it is given,
//! and a file that cannot be read is the same as no choice at all.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

/// Where the tools are, as the user chose them. An absent field is "search for it".
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolChoices {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mkvtoolnix_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ffmpeg: Option<String>,
}

impl ToolChoices {
    /// Blank strings are not choices.
    fn tidy(mut self) -> Self {
        let keep = |v: Option<String>| v.filter(|s| !s.trim().is_empty());
        self.mkvtoolnix_dir = keep(self.mkvtoolnix_dir);
        self.ffmpeg = keep(self.ffmpeg);
        self
    }
}

fn config_file<R: Runtime>(app: &AppHandle<R>, name: &str) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join(name))
}

fn file<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    config_file(app, "tools.json")
}

/// Written beside and renamed, so a crash never leaves half a file.
fn write_atomically(path: &PathBuf, text: String) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let staged = path.with_extension("json.tmp");
    fs::write(&staged, text + "\n").map_err(|e| e.to_string())?;
    fs::rename(&staged, path).map_err(|e| e.to_string())
}

/// How the app behaves, as the user set it. Every field has the safe value as
/// its default, so a missing, old or unreadable file is the safe app.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prefs {
    /// Fix the original files themselves instead of writing fixed copies.
    /// Off unless the user turned it on and confirmed the warning.
    #[serde(default, deserialize_with = "only_true")]
    pub in_place: bool,
    /// When fixing in place (or putting a fix back), give each movie file back
    /// the date it had. Off unless the user turned it on.
    #[serde(default, deserialize_with = "only_true")]
    pub keep_dates: bool,
}

/// A switch is on only when the file says `true`; any other value is off,
/// and does not cost the other switches their values.
fn only_true<'de, D: serde::Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    Ok(serde_json::Value::deserialize(d)? == serde_json::Value::Bool(true))
}

/// Parse the file's text; anything unreadable is the defaults.
pub fn parse_prefs(text: &str) -> Prefs {
    serde_json::from_str::<Prefs>(text).unwrap_or_default()
}

#[tauri::command]
pub fn prefs_load<R: Runtime>(app: AppHandle<R>) -> Prefs {
    config_file(&app, "settings.json")
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .map(|text| parse_prefs(&text))
        .unwrap_or_default()
}

#[tauri::command]
pub fn prefs_save<R: Runtime>(app: AppHandle<R>, prefs: Prefs) -> Result<(), String> {
    let path = config_file(&app, "settings.json")?;
    let text = serde_json::to_string_pretty(&prefs).map_err(|e| e.to_string())?;
    write_atomically(&path, text)
}

/// Parse the file's text; anything unreadable is no choice.
pub fn parse(text: &str) -> ToolChoices {
    serde_json::from_str::<ToolChoices>(text)
        .unwrap_or_default()
        .tidy()
}

/// The remembered choice, or none.
#[tauri::command]
pub fn tools_load<R: Runtime>(app: AppHandle<R>) -> ToolChoices {
    file(&app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .map(|text| parse(&text))
        .unwrap_or_default()
}

/// Remember the choice. With nothing chosen the file is removed.
#[tauri::command]
pub fn tools_save<R: Runtime>(app: AppHandle<R>, tools: ToolChoices) -> Result<(), String> {
    let tools = tools.tidy();
    let path = file(&app)?;
    if tools == ToolChoices::default() {
        return match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        };
    }
    let text = serde_json::to_string_pretty(&tools).map_err(|e| e.to_string())?;
    write_atomically(&path, text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_what_it_writes_and_survives_junk() {
        let both = ToolChoices {
            mkvtoolnix_dir: Some("C:\\Program Files\\MKVToolNix".into()),
            ffmpeg: Some("/opt/ffmpeg/bin/ffmpeg".into()),
        };
        let text = serde_json::to_string(&both).unwrap();
        assert!(text.contains("mkvtoolnixDir"));
        assert_eq!(parse(&text), both);
        assert_eq!(parse("not json"), ToolChoices::default());
        assert_eq!(parse("{\"ffmpeg\": 3}"), ToolChoices::default());
        assert_eq!(
            parse("{\"ffmpeg\": \"  \", \"mkvtoolnixDir\": \"/x\", \"other\": 1}"),
            ToolChoices {
                mkvtoolnix_dir: Some("/x".into()),
                ffmpeg: None
            }
        );
        assert_eq!(serde_json::to_string(&ToolChoices::default()).unwrap(), "{}");
    }

    #[test]
    fn in_place_fixing_is_off_unless_the_file_says_on() {
        assert!(!Prefs::default().in_place);
        assert!(!parse_prefs("").in_place);
        assert!(!parse_prefs("not json").in_place);
        assert!(!parse_prefs("{}").in_place);
        assert!(!parse_prefs("{\"inPlace\": \"yes\"}").in_place);
        assert!(!parse_prefs("{\"inPlace\": 1}").in_place);
        assert!(!parse_prefs("{\"in_place\": true}").in_place);
        assert!(parse_prefs("{\"inPlace\": true, \"later\": 3}").in_place);
        let on = Prefs { in_place: true, keep_dates: false };
        assert_eq!(parse_prefs(&serde_json::to_string(&on).unwrap()), on);
    }

    #[test]
    fn keeping_dates_is_off_unless_the_file_says_on() {
        assert!(!Prefs::default().keep_dates);
        assert!(!parse_prefs("").keep_dates);
        assert!(!parse_prefs("not json").keep_dates);
        assert!(!parse_prefs("{}").keep_dates);
        assert!(!parse_prefs("{\"inPlace\": true}").keep_dates);
        assert!(!parse_prefs("{\"keepDates\": \"yes\"}").keep_dates);
        assert!(!parse_prefs("{\"keepDates\": 1}").keep_dates);
        assert!(!parse_prefs("{\"keep_dates\": true}").keep_dates);
        assert!(parse_prefs("{\"keepDates\": true, \"later\": 3}").keep_dates);
        // One switch's bad value leaves the other as the file says.
        assert_eq!(
            parse_prefs("{\"inPlace\": true, \"keepDates\": \"yes\"}"),
            Prefs { in_place: true, keep_dates: false }
        );
        assert_eq!(
            parse_prefs("{\"inPlace\": 1, \"keepDates\": true}"),
            Prefs { in_place: false, keep_dates: true }
        );
        let both = Prefs { in_place: true, keep_dates: true };
        let text = serde_json::to_string(&both).unwrap();
        assert!(text.contains("keepDates"));
        assert_eq!(parse_prefs(&text), both);
    }
}
