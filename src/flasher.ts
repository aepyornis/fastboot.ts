import {
  ZipReader,
  BlobReader,
  BlobWriter,
  TextWriter,
  Entry,
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
  | "help"

type Instruction = {
  command: CommandName
  args: string[]
  options: object
}

function getEntry(entries: Entry[], filename: string): Entry {
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

  let command: CommandName
  const args = []
  const options = {}

  const words = text.split(" ").map((x) => x.trim())

  for (const word of words) {
    if (word[0] === "-") {
      if (word === "-w" || word === "--wipe") {
        options.wipe = true
      } else if (word === "--set-active=other") {
        options.setActive = "other"
      } else if (word === "--set-active=a" || word === "--set-active=b") {
	options.setActive = word.slice(-1)
      } else if (word === "--slot-other") {
        options.slot = "other"
      } else if (word.slice(0, 6) === "--slot") {
        const slot = word.split("=")[1]
        if (!["current", "other", "a", "b"].includes(slot)) {
          throw new Error(`unknown slot: ${slot}`)
        }
        options.slot = slot
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
        command = word
      }
    }
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
  reader: ZipReader

  constructor(client: FastbootClient, blob: Blob) {
    this.client = client
    this.reader = new ZipReader(new BlobReader(blob))
  }

  // parses and runs flash-all.sh. it ignores all shell commands
  // except fastboot or sleep
  async runFlashAll() {
    const entries: Entry[] = await this.reader.getEntries()
    const flashAllSh = await getEntry(entries, "flash-all.sh").getData(
      new TextWriter(),
    )

    const instructions = flashAllSh
      .split("\n")
      .map((x) => x.trim())
      .filter((x) => x.slice(0, 9) === "fastboot " || x.slice(0, 5) === "sleep")
      .join("\n")

    return this.run(instructions)
  }

  async run(instructions: text) {
    const entries: Entry[] = await this.reader.getEntries() // io with factory.zip
    const commands: Instruction[] = parseInstructions(instructions)
    console.log(commands)

    for (const command of commands) {
      this.client.logger.log(`‣ ${JSON.stringify(command)}`)
      if (command.command === "flash") {
        const partition = command.args[0]
        const filename = command.args[1]
        const slot = command.options.slot || "current"
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
        const nestedZipEntry = getEntry(entries, command.args[0])
        const zipBlob = await nestedZipEntry.getData(
          new BlobWriter("application/zip"),
        )
        const zipReader = new ZipReader(new BlobReader(zipBlob))
        const nestedEntries = await zipReader.getEntries()
        const fastbootInfoFile = nestedEntries.find(
          (e) => e.filename === "fastboot-info.txt",
        )
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
        const clientVar = await this.client.getVar(command.args[0])
        this.client.logger(`getVar(${command.args[0]}) => ${clientVar}`)
      } else if (command.command === "erase") {
        await this.client.erase(command.args[0])
      } else if (command.command === "sleep") {
        const ms = command.args[0] ? parseInt(command.args[0]) * 1000 : 5000
        await new Promise((resolve) => setTimeout(resolve, ms))
        // do_oem_command in cpp is raw command?
      } else if (command.command === "oem") {
        // motorola setting that does nothing useful here?
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
