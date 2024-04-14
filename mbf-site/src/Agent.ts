import { AdbSync, AdbSyncWriteOptions, Adb, encodeUtf8 } from '@yume-chan/adb';
import { ConsumableReadableStream, Consumable, DecodeUtf8Stream, ConcatStringStream } from '@yume-chan/stream-extra';
import { Request, Response, LogMsg, ModStatus, Mods, ImportedMod, ImportResult, FixedPlayerData } from "./Messages";
import { ManifestMod, Mod } from './Models';

const AgentPath: string = "/data/local/tmp/mbf-agent";

// Currently, it seems like the ADB implementation deadlocks when 
// using the constructor of ConsumableReadableStream to properly read data in a streamed manner.
// As a temporary solution, we will load files into a Uint8Array and then queue this in one go - it seems to fix the problem
// TODO: Properly diagnose the bug and file a report.
function readableStreamBodge(array: Uint8Array): ConsumableReadableStream<Uint8Array> {
  return new ConsumableReadableStream({
    start(controller) {
      controller.enqueue(array);
      controller.close();
    },
  });
}

export async function prepareAgent(adb: Adb) {
  const sync = await adb.sync();
  console.group("Pushing agent");
  try {
    console.log("Removing existing agent");
    await adb.subprocess.spawnAndWait("rm " + AgentPath)
    console.log("Writing new agent")
    await saveAgent(sync);
    await adb.subprocess.spawnAndWait("chmod +x " + AgentPath);

    console.log("Agent is ready");
  } finally {
    sync.dispose();
    console.groupEnd();
  }
}

async function saveAgent(sync: AdbSync) {
  console.log("Downloading agent");
  const agent: Uint8Array = await downloadAgent();

  // TODO: properly use readable streams
  const file: ConsumableReadableStream<Uint8Array> = readableStreamBodge(agent);

  const options: AdbSyncWriteOptions = {
    filename: AgentPath,
    file
  };

  await sync.write(options);
}
  
async function downloadAgent(): Promise<Uint8Array> {
    const resp = await fetch("mbf-agent");
    if(resp.body === null) {
        throw new Error("Agent response had no body")
    }

    return new Uint8Array(await resp.arrayBuffer());
}

function logFromAgent(log: LogMsg) {
  switch(log.level) {
    case 'Error':
      console.error(log.message);
      break;
    case 'Warn':
      console.warn(log.message);
      break;
    case 'Debug':
      console.debug(log.message);
      break;
    case 'Info':
      console.info(log.message);
      break;
    case 'Trace':
      console.trace(log.message);
  }
}

export type LogEventSink = ((event: LogMsg) => void) | null;

async function sendRequest(adb: Adb, request: Request, eventSink: LogEventSink = null): Promise<Response> {
  let command_buffer = encodeUtf8(JSON.stringify(request) + "\n");

  let agentProcess = await adb.subprocess.shell(AgentPath);

  const stdin = agentProcess.stdin.getWriter();
  try {
    stdin.write(new Consumable(command_buffer));
  } finally {
    stdin.releaseLock();
  }

  let exited = false;
  agentProcess.exit.then(() => exited = true);

  const reader = agentProcess.stdout
    // TODO: Not totally sure if this will handle non-ASCII correctly.
    // Doesn't seem to consider that a chunk might not be valid UTF-8 on its own
    .pipeThrough(new DecodeUtf8Stream())
    .getReader();
  
  console.group("Agent Request");
  let buffer = "";
  let response: Response | null = null;
  while(!exited) {
    const result = await reader.read();
    const receivedStr = result.value;
    if(receivedStr === undefined) {
      continue;
    }

    // TODO: This is fairly inefficient in terms of memory usage
    // (although we aren't receiving a huge amount of data so this might be OK)
    buffer += receivedStr;
    const messages = buffer.split("\n");
    buffer = messages[messages.length - 1];

    for(let i = 0; i < messages.length - 1; i++) {
      // Parse each newline separated message as a Response
      let msg_obj: Response;
      try {
        msg_obj = JSON.parse(messages[i]) as Response;
      } catch(e) {
        throw new Error("Agent message " + messages[i] + " was not valid JSON");
      }
      if(msg_obj.type === "LogMsg") {
        const log_obj = msg_obj as LogMsg;
        logFromAgent(log_obj);
        if(eventSink != null) {
          eventSink(log_obj);
        }

        // Errors need to be thrown later in the function
        if(msg_obj.level === 'Error') {
          response = msg_obj;
        }
      } else  {
        // The final message is the only one that isn't of type `log`.
        // This contains the actual response data
        response = msg_obj;
      }
    }
  }
  console.groupEnd();

  if((await agentProcess.exit) === 0) {
    if(response === null) {
      throw new Error("Received error response from agent");
    } else if(response.type === 'LogMsg') {
      const log = response as LogMsg;
      throw new Error("Received error from backend: `" + log.message + "`");
    } else  {
      return response;
    }
  } else  {
    // If the agent exited with a non-zero code then it failed to actually write a response to stdout
    // Alternatively, the agent might be corrupt.
    throw new Error("Failed to invoke agent: is the executable corrupt?" + 
      await agentProcess.stderr
        .pipeThrough(new DecodeUtf8Stream())
        .pipeThrough(new ConcatStringStream()))
  }
}

// Gets the status of mods from the quest, i.e. whether the app is patched, and what mods are currently installed.
export async function loadModStatus(device: Adb): Promise<ModStatus> {
  await prepareAgent(device);

  return await sendRequest(device, {
      type: 'GetModStatus'
  }) as ModStatus;
}

// Tells the backend to attempt to uninstall/install the given mods, depending on the new install status provided in `changesRequested`.
export async function setModStatuses(device: Adb,
  changesRequested: { [id: string]: boolean },
  eventSink: LogEventSink = null): Promise<Mod[]> {
  let response = await sendRequest(device, {
      type: 'SetModsEnabled',
      statuses: changesRequested
  }, eventSink);

  return (response as Mods).installed_mods;
}


export async function importFile(device: Adb,
    file: File,
    eventSink: LogEventSink = null): Promise<ImportResult> {
  const sync = await device.sync();
  const tempPath = "/data/local/tmp/mbf-uploads/" + file.name;
  try {
    
    console.log("Uploading to " + tempPath);
    // TODO: Properly use readable streams, see readableStreamBodge
    const fileStream = readableStreamBodge(new Uint8Array(await file.arrayBuffer()))

    await sync.write({
      filename: tempPath,
      file: fileStream
    })

    const response = await sendRequest(device, {
      'type': 'Import',
      from_path: tempPath
    }, eventSink);

    return response as ImportResult;
  } finally {
    sync.dispose();
  }
}

export async function importModUrl(device: Adb,
url: string,
eventSink: LogEventSink = null) {
  const response = await sendRequest(device, {
    'type': 'ImportModUrl',
    from_url: url
  }, eventSink);

  return response as ImportedMod;
}

export async function removeMod(device: Adb,
  mod_id: string,
  eventSink: LogEventSink = null) {
  let response = await sendRequest(device, {
      type: 'RemoveMod',
      id: mod_id
  }, eventSink);

  return (response as Mods).installed_mods;
}

// Instructs the agent to patch the app, adding the modloader and installing the core mods.
// Updates the ModStatus `beforePatch` to reflect the state of the installation after patching.
// (will not patch if the APK is already modded - will just extract the modloader and install core mods.)
export async function patchApp(device: Adb,
  beforePatch: ModStatus,
  downgradeToVersion: string | null,
  manifestMod: ManifestMod,
  remodding: boolean,
  eventSink: LogEventSink = null): Promise<ModStatus> {
  let response = await sendRequest(device, {
      type: 'Patch',
      downgrade_to: downgradeToVersion,
      manifest_mod: manifestMod,
      remodding
  }, eventSink);

  // Return the new mod status assumed after patching
  // (patching should fail if any of this is not the case)
  return {
      'type': 'ModStatus',
      app_info: {
          loader_installed: 'Scotland2',
          version: downgradeToVersion ?? beforePatch.app_info!.version
      },
      core_mods: {
          all_core_mods_installed: true,
          supported_versions: beforePatch.core_mods!.supported_versions,
          downgrade_versions: []
      },
      modloader_present: true,
      installed_mods: (response as Mods).installed_mods
  };
}

// Instructs the agent to download and install any missing/outdated core mods, as well as push the modloader to the required location.
// Should fix many common issues with an install.
export async function quickFix(device: Adb,
  beforeFix: ModStatus,
  eventSink: LogEventSink = null): Promise<ModStatus> {
  let response = await sendRequest(device, {
      type: 'QuickFix'
  }, eventSink);

  // Update the mod status to reflect the fixed installation
  return {
      'type': 'ModStatus',
      app_info: beforeFix.app_info,
      core_mods: {
          all_core_mods_installed: true,
          supported_versions: beforeFix.core_mods!.supported_versions,
          downgrade_versions: beforeFix.core_mods!.downgrade_versions
      },
      installed_mods: (response as Mods).installed_mods,
      modloader_present: true
  }
}

// Attempts to fix the black screen issue on Quest 3.
export async function fixPlayerData(device: Adb,
  eventSink: LogEventSink = null): Promise<boolean> {
  let response = await sendRequest(device, { type: 'FixPlayerData' }, eventSink);

  return (response as FixedPlayerData).existed
}