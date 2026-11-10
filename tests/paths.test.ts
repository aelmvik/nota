import { describe, expect, it } from 'vitest'
import { fileName } from '../src/shared/paths'

describe('file names in messages', () => {
  it('shows the name alone on every system', () => {
    expect(fileName('/Users/me/Music/Song.mp3')).toBe('Song.mp3')
    expect(fileName('C:\\Users\\me\\Music\\Song.mp3')).toBe('Song.mp3')
    expect(fileName('Song.mp3')).toBe('Song.mp3')
  })
})
