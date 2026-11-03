// Build only these public source assets. Never copy an installed environment.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'plugin/addon/content/runtime');
const names = [
    'runtime/bootstrap.py', 'runtime/security.py',
    'runtime/requirements-server.txt', 'runtime/requirements-engine.txt',
    'server/server.py', 'server/index.html', 'server/favicon.svg',
    'server/config/config.json.example', 'server/config/config.toml.example', 'server/config/venv.json.example',
    ...['auto_update', 'config', 'config_map', 'config_migration', 'cropper', 'deepseek_thinking',
        'environment_lifecycle', 'execute', 'package_network', 'privacy', 'record', 'silent_process', 'task_manager', 'venv']
        .map(name => `server/utils/${name}.py`),
].sort();
const mapping = [...names.map(name => [name, name]), ['LICENSE', 'runtime/LICENSE']];
const allowed = new Set([...mapping.map(([, name]) => name), 'runtime-manifest.json']);
function inspect(directory, prefix = '') {
    if (!fs.existsSync(directory)) return;
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Refusing linked asset directory');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const relative = prefix + entry.name;
        if (entry.isSymbolicLink()) throw new Error('Refusing linked runtime asset');
        if (entry.isDirectory()) inspect(path.join(directory, entry.name), relative + '/');
        else if (!allowed.has(relative)) throw new Error(`Unexpected generated asset: ${relative}. Review before rebuilding.`);
    }
}
inspect(output);
const files = mapping.map(([source, name]) => {
    const sourcePath = path.join(root, source);
    if (!fs.lstatSync(sourcePath).isFile()) throw new Error(`Not a regular public source asset: ${source}`);
    const bytes = fs.readFileSync(sourcePath);
    if (bytes.length > 1024 * 1024) throw new Error(`Oversized source asset: ${source}`);
    const destination = path.join(output, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
    return { path: name, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
});
files.sort((a, b) => a.path.localeCompare(b.path));
fs.writeFileSync(path.join(output, 'runtime-manifest.json'), JSON.stringify({ version: '0.1.0', files }, null, 2) + '\n');
console.log(`Packaged ${files.length} source-only runtime assets.`);
