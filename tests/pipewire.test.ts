import { describe, expect, it } from 'vitest'
import { cardNodes, findCard } from '../src/main/pipewire'

// The shape pw-dump prints, cut down to what the lookup reads.
const node = (id: number, deviceId: number, mediaClass: string, description: string) => ({
  id,
  type: 'PipeWire:Interface:Node',
  info: { props: { 'device.id': deviceId, 'media.class': mediaClass, 'node.description': description } }
})
const card = (id: number, profiles: string[]) => ({
  id,
  type: 'PipeWire:Interface:Device',
  info: { props: {}, params: { EnumProfile: profiles.map((name, index) => ({ index, name })) } }
})

describe('PipeWire cards', () => {
  const surround = [
    card(84, ['off', 'output:analog-surround-71+input:analog-surround-71', 'pro-audio']),
    node(90, 84, 'Audio/Source', 'Interface Eight Analog Surround 7.1'),
    node(91, 84, 'Audio/Sink', 'Interface Eight Analog Surround 7.1'),
    card(50, ['off', 'output:analog-stereo']),
    node(60, 50, 'Audio/Sink', 'Built-in Audio Analog Stereo')
  ]

  it('finds the card behind a JACK name, and its Pro Audio profile', () => {
    expect(findCard(surround, 'Interface Eight Analog Surround 7.1')).toEqual({ deviceId: 84, proAudioIndex: 2 })
    expect(findCard(surround, 'Built-in Audio Analog Stereo')).toEqual({ deviceId: 50, proAudioIndex: null })
    expect(findCard(surround, 'Nothing')).toBeNull()
  })

  it('reads the new input and output names after the switch', () => {
    const pro = [card(84, ['off', 'pro-audio']), node(92, 84, 'Audio/Source', 'Interface Eight Pro'), node(93, 84, 'Audio/Sink', 'Interface Eight Pro')]
    expect(cardNodes(pro, 84)).toEqual({ input: 'Interface Eight Pro', output: 'Interface Eight Pro' })
  })
})
