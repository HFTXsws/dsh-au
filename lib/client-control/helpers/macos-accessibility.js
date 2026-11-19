/* global Application, ObjC, $, delay */
'use strict'

ObjC.import('Foundation')

function fail(message) {
  throw new Error(`dsh-au-client-control-accessibility: ${message}`)
}

function readJson(filePath) {
  const text = $.NSString.stringWithContentsOfFileEncodingError(
    filePath,
    $.NSUTF8StringEncoding,
    null
  )
  if (!text) fail(`cannot read config: ${filePath}`)
  return JSON.parse(ObjC.unwrap(text))
}

function property(element, key, fallback = '') {
  try {
    const value = element.properties()[key]
    return value === undefined || value === null ? fallback : value
  } catch (_) {
    return fallback
  }
}

function normalize(value) {
  return String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim()
}

function descendants(root) {
  const result = []
  const pending = [root]
  while (pending.length) {
    const current = pending.shift()
    let children = []
    try { children = current.uiElements() } catch (_) { children = [] }
    for (const child of children) {
      result.push(child)
      pending.push(child)
    }
  }
  return result
}

function accessibleText(element) {
  const props = element.properties()
  return [props.name, props.description, props.value]
    .filter((value) => typeof value === 'string' && value.length)
}

function unique(elements, predicate, label) {
  const matches = elements.filter(predicate)
  if (matches.length !== 1) fail(`missing or ambiguous control: ${label}`)
  return matches[0]
}

function buttonName(element) {
  const props = element.properties()
  return normalize(props.name || props.description || props.title || props.value)
}

function promptInput(elements) {
  return unique(elements, (element) => {
    const props = element.properties()
    const role = props.role
    const label = normalize(props.name || props.description || props.help)
    return (role === 'AXTextArea' || role === 'AXTextField')
      && (label === 'Prompt' || label.includes('Prompt'))
  }, 'Prompt')
}

function press(element) {
  let actions = []
  try { actions = element.actions.whose({ name: 'AXPress' })() } catch (_) { actions = [] }
  if (actions.length !== 1) fail('Control does not expose exactly one AXPress action')
  actions[0].perform()
}

function claudeProcess() {
  const systemEvents = Application('System Events')
  const processes = systemEvents.applicationProcesses.whose({ name: 'Claude' })()
  if (processes.length !== 1) fail('Claude process is missing or ambiguous')
  const process = processes[0]
  if (!process.frontmost()) fail('Claude must be the frontmost application')
  if (!process.windows().length) fail('Claude has no accessible window')
  return process
}

function projectName(config) {
  const parts = String(config.ProjectDir).split(/[\\/]/).filter(Boolean)
  if (!parts.length) fail('requested project directory has no name')
  return parts[parts.length - 1]
}

function findNewContext(process, config, allowMissing, allowPrepared = false) {
  const windows = process.windows()
  const window = windows[0]
  const webAreas = descendants(window).filter((element) => {
    const role = property(element, 'role')
    return role === 'AXWebArea' || role === 'AXDocument'
  })
  if (webAreas.length === 0 && allowMissing) return null
  if (webAreas.length !== 1) fail('active Claude document is missing or ambiguous')
  const document = webAreas[0]
  const elements = descendants(document)
  const texts = [].concat.apply([], elements.map(accessibleText)).map(normalize).filter(Boolean)
  const requestedPath = normalize(String(config.ProjectDir).replace(/\/+$/, ''))
  const projectPaths = elements.filter((element) => accessibleText(element).some((value) => {
    return normalize(String(value).replace(/\/+$/, '')) === requestedPath
  }))
  if (projectPaths.length === 0 && allowMissing) return null
  if (projectPaths.length !== 1) fail('full project path is missing or ambiguous in the blank session')
  if (texts.some((text) => text.startsWith('You said: ') || text.startsWith('Claude responded: '))) {
    if (allowMissing) return null
    fail('active view is not a blank new session')
  }

  const inputs = elements.filter((element) => {
    const props = element.properties()
    const label = normalize(props.name || props.description || props.help)
    return (props.role === 'AXTextArea' || props.role === 'AXTextField')
      && (label === 'Prompt' || label.includes('Prompt'))
  })
  if (inputs.length === 0 && allowMissing) return null
  if (inputs.length !== 1) fail('Prompt is missing or ambiguous')
  const input = inputs[0]
  const environmentName = `Environment: ${projectName(config)}`
  const environments = elements.filter((element) => {
    return property(element, 'role') === 'AXButton' && buttonName(element) === environmentName
  })
  if (environments.length === 0 && allowMissing) return null
  if (environments.length !== 1) fail('requested project environment is missing or ambiguous')
  if (property(environments[0], 'enabled', true) === false) fail('project environment is unavailable')

  const draft = String(property(input, 'value'))
  if (draft !== '' && !(allowPrepared && draft === config.Prompt)) {
    fail('existing draft preserved; refusing to overwrite it')
  }
  return {
    process,
    window,
    document,
    elements,
    input,
    draft,
    fingerprint: {
      Pid: String(process.unixId()),
      WindowTitle: String(property(window, 'name')),
      DocumentRole: String(property(document, 'role')),
      DocumentTitle: String(property(document, 'name')),
      InputRole: String(property(input, 'role')),
      InputDescription: String(property(input, 'description') || property(input, 'name')),
      DraftBefore: draft
    }
  }
}

function openNewContext(config) {
  const process = claudeProcess()
  const existing = findNewContext(process, config, true)
  if (existing) return existing

  let elements = []
  for (const window of process.windows()) elements = elements.concat(descendants(window))
  const expected = `New session in ${projectName(config)}`
  const open = unique(elements, (element) => {
    return property(element, 'role') === 'AXButton' && buttonName(element) === expected
  }, expected)
  if (property(open, 'enabled', true) === false) fail('requested project new-session button is unavailable')
  press(open)

  for (let attempt = 0; attempt < 100; attempt += 1) {
    delay(0.1)
    const opened = findNewContext(process, config, true)
    if (opened) return opened
  }
  fail('requested project blank new session did not appear after opening')
}

function context(action, config) {
  const process = claudeProcess()
  if (action.startsWith('New')) {
    const current = findNewContext(
      process,
      config,
      false,
      action === 'NewPrepare' || config.AllowPrepared === true
    )
    if (!current) fail('active view is not the requested blank new session')
    return current
  }

  const windows = process.windows()
  const matches = []
  for (const candidate of windows) {
    for (const element of descendants(candidate)) {
      const role = property(element, 'role')
      const titleMatches = normalize(property(element, 'name')) === normalize(config.Title)
      if ((role === 'AXWebArea' || role === 'AXDocument') && titleMatches) {
        matches.push({ window: candidate, document: element })
      }
    }
  }
  if (matches.length !== 1) fail('target Claude document is missing or ambiguous')
  const window = matches[0].window
  const document = matches[0].document
  const elements = descendants(document)
  const texts = [].concat.apply([], elements.map(accessibleText)).map(normalize).filter(Boolean)
  const input = promptInput(elements)
  const draft = String(property(input, 'value'))
  const lastUser = normalize(config.LastUser)
  const previousReply = normalize(config.PreviousReply)
  if (!texts.some((text) => text === lastUser || text.endsWith(lastUser))) {
    fail('latest human turn is not visible in the target session')
  }
  const visible = normalize(texts.join(' '))
  if (!previousReply || !visible.includes(previousReply)) {
    fail('latest complete assistant reply is not visible in the target session')
  }
  const allowPrepared = action === 'Prepare'
  if (draft !== '' && !(allowPrepared && draft === config.Prompt)) {
    fail('existing draft preserved; refusing to overwrite it')
  }
  return {
    process,
    window,
    document,
    elements,
    input,
    draft,
    fingerprint: {
      Pid: String(process.unixId()),
      WindowTitle: String(property(window, 'name')),
      DocumentRole: String(property(document, 'role')),
      DocumentTitle: String(property(document, 'name')),
      InputRole: String(property(input, 'role')),
      InputDescription: String(property(input, 'description') || property(input, 'name')),
      DraftBefore: draft
    }
  }
}

function sameFingerprint(actual, expected) {
  for (const key of ['Pid', 'WindowTitle', 'DocumentRole', 'DocumentTitle', 'InputRole', 'InputDescription']) {
    if (String(actual[key]) !== String(expected && expected[key])) {
      fail('window or chat changed after preparation; nothing was sent')
    }
  }
}

function run(argv) {
  if (argv.length !== 2) fail('expected action and config path')
  const [action, configPath] = argv
  const allowed = ['Inspect', 'Prepare', 'Send', 'NewOpen', 'NewInspect', 'NewPrepare', 'NewSend']
  if (!allowed.includes(action)) fail(`unsupported action: ${action}`)
  const config = readJson(configPath)
  const current = action === 'NewOpen' ? openNewContext(config) : context(action, config)

  if (!['Inspect', 'NewOpen', 'NewInspect'].includes(action)) {
    sameFingerprint(current.fingerprint, config.Fingerprint)
  }
  if (action === 'Prepare' || action === 'NewPrepare') {
    if (current.draft !== config.Prompt) current.input.value = config.Prompt
    delay(0.1)
    if (String(property(current.input, 'value')) !== config.Prompt) {
      fail('prompt could not be verified; nothing was sent')
    }
  }
  if (action === 'Send' || action === 'NewSend') {
    if (String(property(current.input, 'value')) !== config.Prompt) {
      fail('draft changed after preparation; nothing was sent')
    }
    const send = unique(current.elements, (element) => {
      return property(element, 'role') === 'AXButton' && buttonName(element) === 'Send'
    }, 'Send')
    if (property(send, 'enabled', true) === false) fail('Send button is unavailable')
    press(send)
  }
  return JSON.stringify(current.fingerprint)
}
