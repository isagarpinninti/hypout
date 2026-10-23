# Basic example

Created with `hypout init`: a config and three namespaces (`chat`, `alerts`, `doc`).

```bash
npx @hypout/cli studio
```

Open the link it prints, pick `chat`, and publish. Then, from another terminal in this folder:

```bash
npx @hypout/cli publish alerts notice '{"level":"warn","message":"disk almost full"}'
```
