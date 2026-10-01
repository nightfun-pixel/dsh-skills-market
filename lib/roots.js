/**
 * Skill roots — the directories this machine reads `SKILL.md` from.
 *
 * The `SKILL.md` standard is cross-platform: DSH, Claude Code, Cursor and Codex
 * all read the same file. What differs is *where* they look. DSH's own
 * `@deepseek-ai/dsh-skill-filesystem` resolves two user roots and two project
 * roots, and this module mirrors that resolution exactly so the market lists the
 * same skills the agent will actually load:
 *
 *   user-dsh        `<DSH_HOME>/skills`              (DSH's own user root)
 *   user-agents     `<DSH_AGENTS_HOME>/skills`       (the cross-platform root)
 *   project-dsh     `<project>/.dsh/skills`
 *   project-agents  `<project>/.agents/skills`
 *
 * Two shapes are legal inside a root, and both are scanned:
 *
 *   <root>/<name>/SKILL.md     a bundle — the skill may carry sibling files
 *   <root>/<name>.md           a flat single-file skill
 *
 * Nothing here imports a schema library or a YAML parser: a profile-installed
 * bundle resolves bare specifiers from its own directory, which cannot see the
 * installation's `node_modules`, so the plugin is dependency-free by
 * construction. Only `node:*` builtins are used.
 *
 * @module skills-market/lib/roots
 */

import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** Stable root ids. They cross the HTTP boundary, so they are part of the API. */
export const ROOT = {
  DSH: 'user-dsh',
  AGENTS: 'user-agents',
  PROJECT_DSH: 'project-dsh',
  PROJECT_AGENTS: 'project-agents',
}

/** Pick the first non-empty string, or `undefined`. */
function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/**
 * Resolve the user-level home directories the roots hang off.
 *
 * `DSH_HOME` is deliberately not assumed to be `~/.dsh`: a managed install
 * usually points it somewhere else entirely, and a market that wrote to the
 * literal `~/.dsh` would install skills the agent never reads. The resolved
 * absolute path is reported back to the UI so the user can see where a skill
 * will land before clicking Install.
 *
 * @param config - Normalized plugin config.
 * @param env - Environment to read; injectable for tests.
 * @returns `{ dshHome, agentsHome }`, both absolute.
 */
export function resolveHomes(config = {}, env = process.env) {
  const dshHome = firstNonEmpty(config.dshHome, env.DSH_HOME) ?? path.join(homedir(), '.dsh')
  const agentsHome = firstNonEmpty(config.agentsHome, env.DSH_AGENTS_HOME) ?? path.join(homedir(), '.agents')
  return { dshHome: path.resolve(dshHome), agentsHome: path.resolve(agentsHome) }
}

/**
 * Build the root list for one project scope.
 *
 * @param config - Normalized plugin config; `projectRoot` adds the project roots.
 * @param env - Environment to read; injectable for tests.
 * @returns An array of root descriptors, user roots first.
 */
export function resolveRoots(config = {}, env = process.env) {
  const { dshHome, agentsHome } = resolveHomes(config, env)
  const roots = [
    {
      id: ROOT.DSH,
      label: 'DSH',
      scope: 'user',
      home: dshHome,
      dir: path.join(dshHome, 'skills'),
      installable: true,
      note: 'DSH_HOME/skills — the agent reads this in every project.',
    },
    {
      id: ROOT.AGENTS,
      label: 'Agents',
      scope: 'user',
      home: agentsHome,
      dir: path.join(agentsHome, 'skills'),
      installable: true,
      note: 'Cross-platform root shared by Claude Code, Cursor and Codex.',
    },
  ]

  const projectRoot = firstNonEmpty(config.projectRoot)
  if (projectRoot !== undefined) {
    const resolved = path.resolve(projectRoot)
    roots.push(
      {
        id: ROOT.PROJECT_DSH,
        label: 'Project .dsh',
        scope: 'project',
        home: resolved,
        dir: path.join(resolved, '.dsh', 'skills'),
        installable: false,
        note: 'Checked into this repository.',
      },
      {
        id: ROOT.PROJECT_AGENTS,
        label: 'Project .agents',
        scope: 'project',
        home: resolved,
        dir: path.join(resolved, '.agents', 'skills'),
        installable: false,
        note: 'Cross-platform project root.',
      },
    )
  }

  return roots.map((root) => ({ ...root, exists: existsSync(root.dir) }))
}

/**
 * Look one root up by id.
 * @param roots - The resolved root list.
 * @param id - Root id from the API.
 * @returns The root, or `undefined` when the id is unknown.
 */
export function findRoot(roots, id) {
  return roots.find((root) => root.id === id)
}

/**
 * Reject a skill name that would escape its root.
 *
 * Names arrive from a URL and end up in a `join`, so this is the boundary that
 * keeps `../../` and absolute paths from writing outside the skills directory.
 * The accepted shape matches `isSkillName` in `@deepseek-ai/dsh-skill`: letters,
 * digits, and `-` `_` `.` separators, no leading dot, bounded length.
 *
 * @param name - Candidate skill directory or file name.
 * @returns `true` when the name is a plain, safe single path segment.
 */
export function isSafeSkillName(name) {
  if (typeof name !== 'string') return false
  const value = name.trim()
  if (value === '' || value.length > 128) return false
  if (value.startsWith('.')) return false
  if (value.includes('/') || value.includes('\\')) return false
  if (value.includes('\0')) return false
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
}

/**
 * Resolve one skill's path inside a root, proving it stays inside.
 *
 * @param root - A resolved root descriptor.
 * @param name - Skill name (a directory name for bundles, a stem for flat files).
 * @param flat - `true` to address `<name>.md`, `false` for the `<name>/` bundle.
 * @returns The absolute path.
 * @throws When the name is unsafe or the result escapes the root.
 */
export function resolveSkillPath(root, name, flat = false) {
  if (!isSafeSkillName(name)) {
    throw new Error(`unsafe skill name: ${JSON.stringify(name)}`)
  }
  const target = flat ? path.join(root.dir, `${name}.md`) : path.join(root.dir, name)
  const relative = path.relative(root.dir, target)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`skill path escapes its root: ${target}`)
  }
  return target
}

/**
 * Human-readable size for one file, or `0` when it cannot be read.
 * @param file - Absolute path.
 * @returns Byte count.
 */
export function fileSize(file) {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}
