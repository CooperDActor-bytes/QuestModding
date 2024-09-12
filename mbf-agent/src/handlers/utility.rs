//! Handles requests relating to some buttons in the options page of MBF.

use std::path::Path;

use crate::{data_fix, mod_man::ModManager, patching, requests::Response};
use anyhow::{Context, Result, anyhow};
use log::{debug, info, warn};


/// Handles `QuickFix` [Requests](requests::Request).
/// 
/// # Returns
/// The [Response](requests::Response) to the request (variant `Mods`)
pub(super) fn handle_quick_fix(override_core_mod_url: Option<String>, wipe_existing_mods: bool) -> Result<Response> {
    let app_info = super::mod_status::get_app_info()?
        .ok_or(anyhow!("Cannot quick fix when app is not installed"))?;
    let res_cache = crate::load_res_cache()?;

    let mut mod_manager = ModManager::new(app_info.version.clone(), &res_cache);
    if wipe_existing_mods {
        info!("Wiping all existing mods");
        mod_manager.wipe_all_mods().context("Wiping existing mods")?;
    }
    mod_manager.load_mods()?; // Should load no mods.

    // Reinstall missing core mods and overwrite the modloader with the one contained within the executable.
    super::install_core_mods(&res_cache, &mut mod_manager, app_info, override_core_mod_url)?;
    patching::install_modloader()?;
    Ok(Response::Mods {
        installed_mods: super::mod_management::get_mod_models(mod_manager)?
    })
}

/// Handles `FixPlayerData` [Requests](requests::Request).
/// 
/// # Returns
/// The [Response](requests::Response) to the request (variant `FixedPlayerData`)
pub(super) fn handle_fix_player_data() -> Result<Response> {
    patching::kill_app()?; // Kill app, in case it's still stuck in a hanging state

    let mut did_work = false;
    if Path::new(crate::DATAKEEPER_PATH).exists() {
        info!("Fixing color scheme issues");
        data_fix::fix_colour_schemes(crate::DATAKEEPER_PATH)?;
        did_work = true;
    }
    
    if Path::new(crate::PLAYER_DATA_PATH).exists() {
        info!("Backing up player data");
        patching::backup_player_data()?;

        info!("Removing (potentially faulty) PlayerData.dat in game files");
        debug!("(removing {})", crate::PLAYER_DATA_PATH);
        std::fs::remove_file(crate::PLAYER_DATA_PATH).context("Deleting faulty player data")?;
        if Path::new(crate::PLAYER_DATA_BAK_PATH).exists() {
            std::fs::remove_file(crate::PLAYER_DATA_BAK_PATH)?;
        }
        did_work = true;
    }   else {
        warn!("No player data found to \"fix\"");
    }

    Ok(Response::FixedPlayerData {
        existed: did_work
    })
}