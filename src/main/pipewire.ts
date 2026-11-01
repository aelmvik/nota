import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// Linux: PipeWire runs a multichannel interface in a surround profile by default,
// which names its inputs after speakers in an order that isn't the hardware's.
// Its Pro Audio profile gives the channels in hardware order (Input 1, 2, …).
// Switched only when the user asks (Settings → Audio), with PipeWire's own tools.

const run = promisify(execFile)

interface PwObject {
  id: number
  type: string
  info?: { props?: Record<string, unknown>; params?: Record<string, Array<Record<string, unknown>>> }
}

const props = (o: PwObject) => o.info?.props ?? {}

async function dump(): Promise<PwObject[]> {
  const { stdout } = await run('pw-dump', [], { maxBuffer: 64 * 1024 * 1024 })
  return JSON.parse(stdout) as PwObject[]
}

/** The card behind a JACK device name (PipeWire names JACK clients after the node's description). */
export function findCard(objects: PwObject[], jackName: string) {
  const node = objects.find((o) => o.type.endsWith(':Node') && (props(o)['node.description'] === jackName || props(o)['node.nick'] === jackName))
  const deviceId = node && Number(props(node)['device.id'])
  const device = objects.find((o) => o.type.endsWith(':Device') && o.id === deviceId)
  if (!device) return null
  const profiles = device.info?.params?.EnumProfile ?? []
  const pro = profiles.find((p) => p.name === 'pro-audio')
  return { deviceId: device.id, proAudioIndex: typeof pro?.index === 'number' ? pro.index : null }
}

/** The JACK names of a card's capture and playback nodes. */
export function cardNodes(objects: PwObject[], deviceId: number) {
  const nodes = objects.filter((o) => o.type.endsWith(':Node') && Number(props(o)['device.id']) === deviceId)
  const name = (cls: string) => {
    const n = nodes.find((o) => props(o)['media.class'] === cls)
    return n ? String(props(n)['node.description']) : null
  }
  return { input: name('Audio/Source'), output: name('Audio/Sink') }
}

/**
 * Switches the card behind `jackName` to Pro Audio and returns its new JACK
 * names (the card's nodes are replaced). PipeWire remembers the profile.
 */
export async function useProAudio(jackName: string): Promise<{ input: string | null; output: string | null }> {
  const card = findCard(await dump(), jackName)
  if (!card) throw new Error(`PipeWire doesn’t list ${jackName} as a sound card`)
  if (card.proAudioIndex === null) throw new Error(`${jackName} has no Pro Audio profile`)
  try {
    await run('wpctl', ['set-profile', String(card.deviceId), String(card.proAudioIndex)])
  } catch {
    await run('pw-cli', ['set-param', String(card.deviceId), 'Profile', `{ index: ${card.proAudioIndex}, save: true }`])
  }
  // The new nodes appear a moment later.
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 200))
    const nodes = cardNodes(await dump(), card.deviceId)
    if (nodes.input && nodes.input !== jackName) return nodes
  }
  throw new Error('The interface didn’t come back in Pro Audio')
}
