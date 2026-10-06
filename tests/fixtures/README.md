# Learning delivery fixture

`learning-skills.zip` is a synthetic Intelligence skill snapshot, revision
`fixture-v1`. It contains `manifest.json` and `evidence-review/SKILL.md`; the
manifest records the content's size and SHA-256. ZIP entries have fixed timestamps.
It contains no real conversation data. The native SDK validates this archive in
the delivery integration test before exposing its catalog and tools to the model.
