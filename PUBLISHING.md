# Publishing Guide

## Before publishing

Run from the package root:

```bash
npm run smoke-test
npm run release-check
```

## GitHub release flow

```bash
git init
git add .
git commit -m "Initial release"
git branch -M main
git remote add origin git@github.com:<YOUR-USER>/pi-letscook.git
git push -u origin main
git tag v0.1.0
git push origin v0.1.0
```

Users can then install with:

```bash
pi install git:github.com/<YOUR-USER>/pi-letscook@v0.1.0
```

## npm release flow

For the scoped public package name `@linimin/pi-letscook`, publish with:

```bash
npm login
npm publish --access public
```

Users can then install with:

```bash
pi install npm:@linimin/pi-letscook
```

## Recommended metadata before public release

Consider updating these fields in `package.json` before publishing publicly:

- `name`
- `repository`
- `homepage`
- `bugs`
- `author`

## Versioning

- bump `version` in `package.json`
- add a new entry to `CHANGELOG.md`
- create a matching git tag like `v0.1.1`
