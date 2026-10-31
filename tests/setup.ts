import { join } from 'node:path'
import { setBundledToolsDir } from '../src/main/media'

// Like the app: the tools `npm run tools:build` made come first, a system install second.
setBundledToolsDir(join(__dirname, '..', 'native', 'build', 'tools'))
