# Examples

## Açaí bowls (the bundled example)

The thesis this tool grew out of. The config `configs/acai.yaml` encodes a
four-layer framework, Coloniality, Extractivism/Nature, Branding/Wellness and
Platform Vernacular, applied to `#acaibowl` / `#açaíbowl` posts.

Place the two Zeeschuimer exports next to the repo and run:

```bash
monke-bars analyze \
  --platform instagram \
  --config configs/acai.yaml \
  --outdir runs/acai \
  "#acaibowl_foryou.ndjson" "#açaíbowl_foryou.ndjson"
```

Expected shape of the output (203-post English corpus): `bowl`, `açaí`, `acai`,
`granola`, `perfect`, `fresh` lead the word ranking; Branding/Wellness vocabulary
rises from High to Low tiers while Platform Vernacular falls; top co-occurring
hashtags include `#superfood`, `#smoothiebowl`, `#organic`, `#sambazon`.

## A new study

```bash
monke-bars init configs/mystudy.yaml   # copy the template
# edit configs/mystudy.yaml: seed tags and theme lexicons
monke-bars analyze --platform tiktok --config configs/mystudy.yaml my_scrape.ndjson
```
