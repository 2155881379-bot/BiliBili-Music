const fs = require('node:fs')
const path = require('node:path')
const asar = require('@electron/asar')
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [{ path: path.join(dir, entry.name), bytes: fs.statSync(path.join(dir, entry.name)).size }])
}
const directories = process.argv.length > 2
  ? process.argv.slice(2).map(directory => path.resolve(directory))
  : [path.resolve(__dirname, '../release/win-unpacked')]
const results = directories.filter(fs.existsSync).map(directory => {
  const file = path.join(directory, 'resources/app.asar')
  return {
    directory: path.basename(directory),
    totalMiB: walk(directory).reduce((sum, file) => sum + file.bytes, 0) / 1048576,
    asarMiB: fs.statSync(file).size / 1048576,
    locales: fs.readdirSync(path.join(directory, 'locales')).filter(name => name.endsWith('.pak')),
    mainRequires: [...asar.extractFile(file, path.join('out', 'main', 'index.js')).toString().matchAll(/require\("([^"]+)"\)/g)].map(match => match[1]),
    includesNodeModules: asar.listPackage(file).some(name => name.includes('node_modules'))
  }
})
const output = path.resolve(__dirname, '../output/playwright/performance')
fs.mkdirSync(output, { recursive: true })
fs.writeFileSync(path.join(output, 'package-size.json'), JSON.stringify(results, null, 2))
console.log(JSON.stringify(results, null, 2))
