import { describe, expect, test } from 'bun:test';
import { parseFrontmatter } from '../util/parse-frontmatter.js';

describe('parseFrontmatter', () => {
  test('parses implementer frontmatter (6 tools)', () => {
    const content = `---
name: implementer
description: Focused code implementation agent
tools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep']
---

# Implementer`;

    const meta = parseFrontmatter(content);
    expect(meta.name).toBe('implementer');
    expect(meta.description).toBe('Focused code implementation agent');
    expect(meta.tools).toEqual(['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep']);
    expect(meta.model).toBeUndefined();
  });

  test('parses verifier frontmatter (4 tools)', () => {
    const content = `---
name: verifier
description: Verification agent
tools: ['Read', 'Bash', 'Glob', 'Grep']
---

# Verifier`;

    const meta = parseFrontmatter(content);
    expect(meta.name).toBe('verifier');
    expect(meta.tools).toEqual(['Read', 'Bash', 'Glob', 'Grep']);
  });

  test('parses optional model field', () => {
    const content = `---
name: implementer
description: Agent
tools: ['Read']
model: sonnet
---`;

    const meta = parseFrontmatter(content);
    expect(meta.model).toBe('sonnet');
  });

  test('model is undefined when absent', () => {
    const content = `---
name: implementer
description: Agent
tools: ['Read']
---`;

    const meta = parseFrontmatter(content);
    expect(meta.model).toBeUndefined();
  });

  test('throws on missing frontmatter', () => {
    expect(() => parseFrontmatter('# No frontmatter')).toThrow('No frontmatter found');
  });

  test('throws on missing name', () => {
    const content = `---
description: Agent
tools: ['Read']
---`;

    expect(() => parseFrontmatter(content)).toThrow('missing required field: name');
  });

  test('throws on missing tools', () => {
    const content = `---
name: test
description: Agent
---`;

    expect(() => parseFrontmatter(content)).toThrow('missing required field: tools');
  });

  test('throws on empty tools array', () => {
    const content = `---
name: test
description: Agent
tools: []
---`;

    expect(() => parseFrontmatter(content)).toThrow('tools array is empty');
  });

  test('handles double-quoted tools', () => {
    const content = `---
name: test
description: Agent
tools: ["Read", "Edit"]
---`;

    const meta = parseFrontmatter(content);
    expect(meta.tools).toEqual(['Read', 'Edit']);
  });
});
