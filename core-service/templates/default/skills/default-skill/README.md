# Default Skill (Starter)

This folder is a **scaffold** shipped with every Default workspace so your team can turn it
into your own skill without starting from scratch.

## How to customize

1. Open [SKILL.md](SKILL.md) and edit the YAML frontmatter:
   - `name`: a short kebab-case identifier (e.g. `acme-billing`). It should match this folder name.
   - `description`: when the agent should use this skill. Be specific — this is what the agent
     matches against user requests.
2. Fill in the **When to Use**, **Instructions**, **Examples**, and **References** sections.
3. (Optional) Rename this folder to match your skill `name`.
4. Add supporting material under [references/](references/).

## Structure

```
default-skill/
├── SKILL.md                 # Main skill file (frontmatter + instructions) — required
├── README.md                # This file
└── references/              # Supporting reference documents (optional)
    └── example-reference.md
```

Only `SKILL.md` with a valid `name` and `description` is required for the agent to discover
the skill. Everything else is optional supporting content.
