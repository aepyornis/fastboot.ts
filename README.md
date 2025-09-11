# fastboot.ts

Android Fastboot implementation for WebUSB

```sh
npm install
npm run build
```

    src/device.ts handles interfacing with WebUSB and implements fastboot protocol
    src/client.ts implements higher level API, similar to fastboot cli tool
    src/flasher.ts flashes zip image from a list of instructions
    src/sparse.ts sparse image utilities Copyright (c) 2021 Danny Lin <danny@kdrag0n.dev>

```js
import { FastbootClient, FastbootFlasher } from "@aepyornis/fastboot.ts"

const client = await FastbootClient.create()

// run commands
await client.unlock()
await client.getVar("product")

// flash CalyxOS
import OpfsBlobStore from "@aepyornis/opfs_blob_store"
const opfs = await OpfsBlobStore.create()
const hash = "db9ab330a1b5d5ebf131f378dca8b5f6400337f438a97aef2a09a1ba88f3935c"
const url = "https://release.calyxinstitute.org/bangkk-factory-25608210.zip"
await opfs.fetch(hash, url)
const file = await opfs.get(hash)
const client = await FastbootClient.create()
const deviceFlasher = new FastbootFlasher(client, file)
await deviceFlasher.runFlashAll()
```
