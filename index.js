'use strict'

const _ = require('lodash')
const childProcess = require('child_process')
const fs = require('fs-extra')
const path = require('path')

const pkg = require('./package.json')
const logger = require('debug')(pkg.name)

const promisify = require('es6-promisify')
const writeFile = promisify(fs.writeFile)
const mkdirs = promisify(fs.mkdirs)
const copy = promisify(fs.copy)
const symlink = promisify(fs.symlink)
const tmpdir = promisify(require('tmp').dir)

function kebabify (object) {
  return _.cloneDeepWith(object, (value) => {
    if (!value || typeof value !== 'object') return value

    return Object.keys(value).reduce(function (newValue, key) {
      newValue[_.kebabCase(key)] = value[key]
      return newValue
    }, {})
  })
}

function spawnWithLogging (options, command, args) {
  return new Promise(function (resolve, reject) {
    logger(`$ ${command} ${args.join(' ')}`)
    let child = childProcess.spawn(command, args, { cwd: options['working-dir'] })
    child.stdout.on('data', (data) => {
      logger(`1> ${data}`)
    })
    child.stderr.on('data', (data) => {
      logger(`2> ${data}`)
    })
    child.on('error', (error) => {
      reject(error)
    })
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${command} failed with status code ${code}`))
      }
      resolve()
    })
  })
}

function addCommandLineOption (args, name, value) {
  if (!value) return

  if (value === true) {
    args.push(`--${name}`)
    return
  }

  args.push(`--${name}=${value}`)
}

function getOptionsWithDefaults (options) {
  let defaults = {
    'build-dir': path.join(options['working-dir'], 'build'),
    'repo-dir': path.join(options['working-dir'], 'repo'),
    'manifest-path': path.join(options['working-dir'], 'manifest.json'),
    'extra-flatpak-builder-args': [],
    'extra-flatpak-build-bundle-args': []
  }
  options = _.defaults({}, options, defaults)
  options['working-dir'] = path.resolve(options['working-dir'])
  options['build-dir'] = path.resolve(options['build-dir'])
  options['repo-dir'] = path.resolve(options['repo-dir'])
  options['manifest-path'] = path.resolve(options['manifest-path'])
  options['bundle-path'] = path.resolve(options['bundle-path'])
  return options
}

function getManifestWithDefaults (manifest) {
  let defaults = {
    'branch': 'master',
    'sdk': 'org.freedesktop.Sdk',
    'runtime': 'org.freedesktop.Platform',
    'modules': [],
    'files': [],
    'symlinks': []
  }
  if (typeof manifest['runtime'] === 'undefined') {
    defaults['runtime-version'] = '1.4'
  }
  return _.defaults({}, manifest, defaults)
}

function ensureWorkingDir (options) {
  if (!options['working-dir']) {
    return tmpdir({ dir: '/var/tmp', unsafeCleanup: true })
      .then(function (dir) {
        options['working-dir'] = dir
      })
  } else {
    return mkdirs(options['working-dir'])
  }
}

function writeJsonFile (options, manifest) {
  return writeFile(options['manifest-path'], JSON.stringify(manifest, null, '  '))
}

function copyFiles (options, manifest) {
  let copies = manifest['files'].map(function (sourceDest) {
    let source = path.resolve(sourceDest[0])
    let dest = path.join(options['build-dir'], 'files', sourceDest[1])
    let dir = dest
    if (!_.endsWith(dir, path.sep)) dir = path.dirname(dir)

    logger(`Copying ${source} to ${dest}`)
    return mkdirs(dir)
      .then(function () {
        return copy(source, dest)
      })
  })
  return Promise.all(copies)
}

function createSymlinks (options, manifest) {
  let links = manifest['symlinks'].map(function (targetDest) {
    let target = path.join('/app', targetDest[0])
    let dest = path.join(options['build-dir'], 'files', targetDest[1])
    let dir = path.dirname(dest)

    logger(`Symlinking ${target} at ${dest}`)
    return mkdirs(dir)
      .then(function () {
        symlink(target, dest)
      })
  })
  return Promise.all(links)
}

function flatpakBuilder (options, finish) {
  let args = []
  addCommandLineOption(args, 'arch', options['arch'])
  addCommandLineOption(args, 'gpg-sign', options['gpg-sign'])
  addCommandLineOption(args, 'gpg-homedir', options['gpg-homedir'])
  addCommandLineOption(args, 'subject', options['subject'])
  addCommandLineOption(args, 'body', options['body'])
  addCommandLineOption(args, 'repo', options['repo-dir'])
  addCommandLineOption(args, 'force-clean', true)
  if (!finish) {
    addCommandLineOption(args, 'build-only', true)
  } else {
    addCommandLineOption(args, 'finish-only', true)
  }
  args.concat(options['extra-flatpak-builder-args'])

  args.push(options['build-dir'])
  args.push(options['manifest-path'])
  return spawnWithLogging(options, 'flatpak-builder', args)
}

function flatpakBuildBundle (options, manifest) {
  if (!options['bundle-path']) return

  let args = ['build-bundle']
  addCommandLineOption(args, 'arch', options['arch'])
  addCommandLineOption(args, 'gpg-sign', options['gpg-sign'])
  addCommandLineOption(args, 'gpg-homedir', options['gpg-homedir'])
  addCommandLineOption(args, 'repo-url', options['bundle-repo-url'])
  if (options['build-runtime']) addCommandLineOption(args, 'runtime', true)
  args.concat(options['extra-flatpak-build-bundle-args'])

  args.push(options['repo-dir'])
  args.push(options['bundle-path'])
  args.push(manifest['id'])
  args.push(manifest['branch'])
  return mkdirs(path.dirname(options['bundle-path']))
    .then(function () {
      return spawnWithLogging(options, 'flatpak', args)
    })
}

exports.bundle = function (manifest, options, callback) {
  manifest = kebabify(manifest)
  options = kebabify(options)

  return ensureWorkingDir(options)
    .then(() => {
      options = getOptionsWithDefaults(options)
      manifest = getManifestWithDefaults(manifest)

      logger(`Using manifest...\n${JSON.stringify(manifest, null, '  ')}`)
      logger(`Using options...\n${JSON.stringify(options, null, '  ')}`)
    })
    .then(() => writeJsonFile(options, manifest))
    .then(() => flatpakBuilder(options, false))
    .then(() => copyFiles(options, manifest))
    .then(() => createSymlinks(options, manifest))
    .then(() => flatpakBuilder(options, true))
    .then(() => flatpakBuildBundle(options, manifest))
    .then(function () {
      callback(null, options, manifest)
    }, function (error) {
      callback(error)
    })
}
