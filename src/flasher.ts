import {
  ZipReader,
  BlobReader,
  BlobWriter,
  TextWriter,
  type FileEntry,
} from "@zip.js/zip.js"
import type { FastbootClient } from "./client"

type CommandName =
  | "update"
  | "flashall"
  | "flash"
  | "flashing"
  | "erase"
  | "format"
  | "getvar"
  | "set_active"
  | "boot"
  | "devices"
  | "continue"
  | "reboot"
  | "reboot-bootloader"
  | "sleep"
  | "oem"
  | "help"

type SlotName = "current" | "other" | "a" | "b"

type InstructionOptions = {
  wipe?: boolean
  setActive?: "other" | "a" | "b"
  slot?: SlotName
  skipReboot?: boolean
  applyVbmeta?: boolean
}

type Instruction = {
  command: CommandName
  args: string[]
  options: InstructionOptions
}

const COMMAND_NAMES: ReadonlySet<string> = new Set([
  "update",
  "flashall",
  "flash",
  "flashing",
  "erase",
  "format",
  "getvar",
  "set_active",
  "boot",
  "devices",
  "continue",
  "reboot",
  "reboot-bootloader",
  "sleep",
  "oem",
  "help",
])

function isCommandName(word: string): word is CommandName {
  return COMMAND_NAMES.has(word)
}

function isFileEntry(entry: { directory: boolean }): entry is FileEntry {
  return !entry.directory
}

function requireArg(
  command: CommandName,
  args: string[],
  index: number,
): string {
  const value = args[index]
  if (!value) {
    throw new Error(`Missing argument ${index + 1} for ${command}`)
  }
  return value
}

function getEntry(entries: FileEntry[], filename: string): FileEntry {
  const entry = entries.find(
    (e) => e.filename.split(/[\\/]/).pop() === filename,
  )
  if (entry) {
    return entry
  } else {
    throw new Error(`${filename} not found in zip`)
  }
}

function parseInstruction(text: string): Instruction {
  if (text.slice(0, 8) === "fastboot") {
    text = text.slice(8).trim()
  }

  let command: CommandName | undefined
  const args: string[] = []
  const options: InstructionOptions = {}

  const words = text
    .split(/\s+/)
    .map((x) => x.trim())
    .filter((x) => x !== "")

  for (const word of words) {
    if (word[0] === "-") {
      if (word === "-w" || word === "--wipe") {
        options.wipe = true
      } else if (word === "--set-active=other") {
        options.setActive = "other"
      } else if (word === "--set-active=a" || word === "--set-active=b") {
        const slot = word.slice(-1)
        if (slot === "a" || slot === "b") {
          options.setActive = slot
        }
      } else if (word === "--slot-other") {
        options.slot = "other"
      } else if (word.slice(0, 6) === "--slot") {
        const slot = word.split("=")[1]
        if (!slot) {
          throw new Error("--slot requires a value")
        }
        if (!["current", "other", "a", "b"].includes(slot)) {
          throw new Error(`unknown slot: ${slot}`)
        }
        options.slot = slot as SlotName
      } else if (word === "--skip-reboot") {
        options.skipReboot = true
      } else if (word === "--apply-vbmeta") {
        options.applyVbmeta = true
      } else {
        console.warn(`Unknown option: ${word}`)
      }
    } else {
      if (command) {
        args.push(word)
      } else {
        if (!isCommandName(word)) {
          throw new Error(`Unknown command: ${word}`)
        }
        command = word
      }
    }
  }
  if (!command) {
    throw new Error("Missing command")
  }
  return { command, args, options }
}

function parseInstructions(text: string): Instruction[] {
  return text
    .split("\n")
    .map((x) => x.trim())
    .filter((x) => x !== "")
    .filter((x) => x[0] !== "#")
    .map(parseInstruction)
}

export class FastbootFlasher {
  client: FastbootClient
  reader: ZipReader<BlobReader>

  constructor(client: FastbootClient, blob: Blob) {
    this.client = client
    this.reader = new ZipReader(new BlobReader(blob))
  }

  // parses and runs flash-all.sh. it ignores all shell commands
  // except fastboot or sleep
  async runFlashAll() {
    const entries = (await this.reader.getEntries()).filter(isFileEntry)
    const flashAllSh = await getEntry(entries, "flash-all.sh").getData(
      new TextWriter(),
    )

    this.client.logger.log("flash-all.sh\n" + flashAllSh)
    const instructions = flashAllSh
      .split("\n")
      .map((x) => x.trim())
      .filter((x) => x.slice(0, 9) === "fastboot " || x.slice(0, 5) === "sleep")
      .join("\n")

    return this.run(instructions)
  }

  async run(instructions: string) {
    const entries = (await this.reader.getEntries()).filter(isFileEntry) // io with factory.zip
    const commands: Instruction[] = parseInstructions(instructions)

    for (const command of commands) {
      this.client.logger.log(`‣ ${JSON.stringify(command)}`)
      if (command.command === "flash") {
        const partition = requireArg(command.command, command.args, 0)
        const filename = requireArg(command.command, command.args, 1)
        const slot = command.options.slot ?? "current"
        const entry = getEntry(entries, filename)
        const blob = await entry.getData(
          new BlobWriter("application/octet-stream"),
        )

        await this.client.doFlash(
          partition,
          blob,
          slot,
          Boolean(command.options.applyVbmeta),
        )
      } else if (command.command === "reboot-bootloader") {
        if (command.options.setActive === "other") {
          await this.client.setActiveOtherSlot()
        } else if (command.options.setActive === "a") {
          await this.client.fd.exec("set_active:a")
        } else if (command.options.setActive === "b") {
          await this.client.fd.exec("set_active:b")
        }
        await this.client.rebootBootloader()
      } else if (command.command === "update") {
        const zipName = requireArg(command.command, command.args, 0)
        const nestedZipEntry = getEntry(entries, zipName)
        const zipBlob = await nestedZipEntry.getData(
          new BlobWriter("application/zip"),
        )
        const zipReader = new ZipReader(new BlobReader(zipBlob))
        const nestedEntries = (await zipReader.getEntries()).filter(isFileEntry)
        const fastbootInfoFile = nestedEntries.find(
          (e) => e.filename === "fastboot-info.txt",
        )
        if (!fastbootInfoFile) {
          throw new Error("fastboot-info.txt not found in nested zip")
        }
        const fastbootInfoText = await fastbootInfoFile.getData(
          new TextWriter(),
        )

        this.client.logger.log(`fastboot-info.txt: ${fastbootInfoText}`)

        // fastboot -w update image-lynx-bp1a.250305.019.zip
        await this.client.fastbootInfo(
          nestedEntries,
          fastbootInfoText,
          Boolean(command.options.wipe),
        )
      } else if (command.command === "flashing") {
        if (command.args[0] === "lock") {
          await this.client.lock()
        } else if (command.args[0] === "unlock") {
          await this.client.unlock()
        } else {
          throw new Error(`Unknown command`)
        }
      } else if (command.command === "getvar") {
        const varName = requireArg(command.command, command.args, 0)
        const clientVar = await this.client.getVar(varName)
        this.client.logger.log(`getVar(${varName}) => ${clientVar}`)
      } else if (command.command === "erase") {
        const partition = requireArg(command.command, command.args, 0)
        await this.client.erase(partition)
      } else if (command.command === "sleep") {
        const ms = command.args[0] ? parseInt(command.args[0]) * 1000 : 5000
        await new Promise((resolve) => setTimeout(resolve, ms))
        // do_oem_command in cpp is raw command?
      } else if (command.command === "oem") {
        // ignore motorola oem commands that do nothing useful?
        if (
          command.args[0] === "fb_mode_set" ||
          command.args[0] === "fb_mode_clear"
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10))
        } else {
          throw new Error(
            `Fastboot oem command ${command.args[0]} not implemented`,
          )
        }
      } else {
        throw new Error(`Fastboot command ${command.command} not implemented`)
      }
    }
  }
}
