# Monk-E Bars

**Corpus and account analysis of social media posts captured with [Zeeschuimer](https://github.com/digitalmethodsinitiative/zeeschuimer).**

Monk-E Bars answers two questions about the same capture.

**How is a subject discussed.** The words that dominate, the vocabulary that separates high-engagement posts from low, the hashtags that travel together, the thematic layers of a framework, and the colour palettes of the imagery.

**Which accounts are posting.** One row per account, classified by what it is and ranked by its reach, exported as a spreadsheet to work from.

It grew out of a media-studies thesis on the açaí bowl and was generalised, so a study is one small YAML file and the same pipeline serves any subject in any language.

## Two ways to run it

**In the browser.** The [`web/`](web) folder is a static site with no server behind it. A dropped capture is read, parsed and language-detected inside the tab, once, and every filter after that works on data already in memory, so a click applies in milliseconds and a capture of several thousand posts stays usable. The file never leaves the machine that opened it.

The interface is named in gym terms, and each one carries its plain meaning beside it: the **rack** is what the session keeps, a **program** is the saved setup, **weight classes** are the engagement tiers, **reps** are word counts, **members** are accounts, and an account a filter excludes **didn't make weight**. Two or three files dropped together become **sets**, compared side by side.

```bash
cd web && python3 -m http.server 5173
```

Then open `http://localhost:5173`. Any static host serves the same folder.

**As a Python package.** The research instrument: the command line, topic modelling and colour, which the browser cannot do.

```bash
git clone https://github.com/StudioMonk-E/Monk-E-Bars.git
cd Monk-E-Bars
python -m venv .venv && source .venv/bin/activate
pip install -e ".[app]"
monke-bars analyze --platform instagram --config configs/acai.yaml \
    --outdir runs/acai "#acaibowl_foryou.ndjson"
```

`streamlit run app/streamlit_app.py` opens a local dashboard over the same package, with colour and topics included.

The two share one source of truth. Stopwords, account types, contraction rules and bundled studies live in the package and are exported to `web/data` by `scripts/export_web_data.py`; a test fails when the export goes stale. A program saved in the browser is a study file the package reads, including the themes it modelled and any account type corrected by hand. The browser port was checked against the package on four real captures, and every word ranking, keyness score, theme share, account row and generated finding came out identical.

## What it reads

| Source | Status |
|---|---|
| Instagram, via Zeeschuimer | supported |
| TikTok, via Zeeschuimer | supported |
| CSV, TSV, Excel | supported, needs a column of post text |
| X, Reddit | scaffolds with field maps, see [docs/ROADMAP.md](docs/ROADMAP.md) |

Zeeschuimer stamps `source_platform` on every record, so the adapter is selected from the file. A spreadsheet needs only post text; likes, comments and dates are matched by column name where they exist, and the matching can be corrected before the run. Captures from two platforms can be read in one browser session, where each platform is ranked inside itself; the command line takes one platform per run.

## The analysis

**Keyness.** Raw frequency describes what a corpus is about, and both ends of one usually return much the same words. On the açaí corpus the top and bottom tiers share seven of their top fifteen, both led by *bowl*. Dunning log-likelihood compares one tier against another and surfaces what is over-used there, which is what supports a comparative claim. A log-ratio effect size sits beside it, because log-likelihood alone rewards sheer frequency.

**Findings.** Every statement a corpus supports on its own is generated and printed under its own heading. The tool writes no interpretation. A study config may carry one `claim` line, which prints above the evidence attributed to its author, so a reader never has to guess which sentences came from the data.

**Thematic layers, found in the vocabulary.** In the browser these are found by factorising the vocabulary itself, so a capture on a subject nobody has theorised still gets a set of themes, each labelled by its top three words. They stay editable and are saved into the program, which keeps a study reproducible. A framework written by hand still loads, and the two can be run on the same corpus, which is the practical answer to the standing objection that a dictionary encodes its own conclusion.

**Set comparison.** Two or three captures dropped together stay separate as well as pooled. The comparison measures keyness with the file in place of the tier, which answers what each capture holds that the others do not, beside the words they all share.

**One list from two platforms.** An Instagram and a TikTok capture can be worked in the same session, which is what an outreach list needs: Dutch wedding creators are on both. Weight classes are then cut inside each platform, since likes on one are not likes on the other, and an account posting on both comes back as a single member with both platforms named, linked on the platform its strongest post came from. The Excel list carries a `platforms` column and states the limit in its own caveats sheet.

**Stopwords in 33 languages.** Baked in, taken from the NLTK corpora, selected automatically from the languages a corpus turns out to hold. The wrong list ruins an analysis in silence: a Dutch corpus read through an English list returns a ranking of Dutch grammar.

**Colour.** Post media downloaded and clustered into dominant-colour palettes per engagement tier, with average hue, saturation and brightness.

## Accounts

One row per account, ranked by its strongest single post, with three independent filters.

- **Type**, from words matched against the handle and display name. Generic lists already recognise a shop and a magazine across several languages, and a study adds the vocabulary of its own trade.
- **Verified**, straight from the platform.
- **Reach**, as engagement and, where the platform supplies it, followers.

"Influencer" is composed from those filters and printed with the rule it applies. Nothing in a capture identifies one, so the tool claims nothing it cannot show.

Every classification carries the reason that produced it, and accounts filtered out keep their place on a second sheet with the reason attached. A keyword classifier makes mistakes in both directions, and scanning what it discarded is how those surface.

Output is an Excel workbook: the ranked list with profile links and blank columns for checking, the excluded accounts, and a sheet recording the filters and the caveats so the file explains itself after it is sent on.

## Defining a study

In the browser, the program panel writes one: seed hashtags are found in the capture, a word is benched by clicking it, themes are modelled, and membership types are added as word lists. **Save program** writes the file below, and by hand it is the same file. [configs/template.yaml](configs/template.yaml) is a commented starting point, written as fitness in Spanish to show that nothing about the machinery is wedding-shaped or Dutch.

```yaml
language: nl
since: 2025-08-01
account_types:
  Wedding business:
    handle_words: [fotograf, bruid, trouw, bloem, juwel]
    hashtags: [trouwfotograaf, weddingplanner]
    min_hashtag_hits: 2
  Person: default
audiences:
  Influencers: {types: [Person], min_engagement: 500}
```

Bundled: [`acai.yaml`](configs/acai.yaml) for the thesis study, [`verloofd.yaml`](configs/verloofd.yaml) for a Dutch outreach study, [`generic.yaml`](configs/generic.yaml) for a capture with no framework.

## What it cannot do

Stated here because these shape how the output should be used.

**Follower counts depend on the platform.** TikTok captures carry them on every item. Instagram hashtag captures carry none, verified once across 296 posts. Where followers are unknown, reach is engagement alone, and a small account with one popular post outranks a large one. Those need checking by hand.

**Engagement rate is measured against views.** The For You page serves a video to people who do not follow the account, so a rate taken against followers returns figures in the thousands of percent.

**Account type is a keyword match.** It produces false positives and misses. A couple whose handle contains *official* reads as a business; a garden centre called *tuincentrum* reads as a person until the word is added.

**Language detection is imperfect on short captions**, and closely related languages defeat it. Signals with veto words exist for that case, and Afrikaans against Dutch is the worked example. The browser uses a different detector from the package, franc against langdetect, restricted to the 33 languages with stopword lists. On 432 real posts the two agree on 82 percent, and a sample of the disagreements was mostly Dutch that both detectors got wrong in equal measure. A figure that has to match a published study comes from the package.

**A language filter removes a great deal.** On the açaí corpus, keeping English only removed 196 of 399 posts, which is 49 percent of the capture. Portuguese-language posts are absent from every figure in that study, and on a Brazilian ingredient that is a scoping decision with consequences.

## Hosting

The browser app is static files. On Vercel, the project's Root Directory is `web` with no build command; `web/.vercelignore` keeps the tests and Node tooling out of the deployment.

A hosted copy holds no data. Every capture is processed in the visitor's own browser and nothing is uploaded, which removes the risk a hosted Python dashboard carried, where an open instance received other people's captures on a shared server.

## Data and privacy

Captures hold personal data, and the account list holds more of it: named individuals, profile links, engagement, in a file built to be shared. Handle it under the same rules as any other personal data, and check that a scrape is permitted before running one for commercial purposes.

`.gitignore` keeps captures and exported workbooks out of version control. The repository carries no scraped data, and the browser tests run on synthetic records only.

## Layout

```
monke_bars/          the package
  ingest/            adapters, one PostRecord out of every platform
  detect.py          what a dropped file is, and which platform
  corpus.py          dedup, date window, language, engagement tiers
  stopwords.py       33 languages
  lexical.py         frequency, keyness, n-grams, hashtags, themes
  topics.py          unsupervised topic discovery
  findings.py        the statements a corpus supports on its own
  accounts.py        account rollup, classification, filters
  export.py          the Excel workbook
  color.py           media download and palettes
  branding.py        the studio identity, one place
  viz.py             matplotlib charts for the CLI
app/streamlit_app.py the local dashboard
web/                 the browser app, a port of the package
  js/                ingest, text, corpus, lexical, accounts, findings, topics, export
  data/              generated by scripts/export_web_data.py
  tests/             node --test, synthetic records
configs/             studies
scripts/export_web_data.py  writes web/data
scripts/voice_check.py      prose check against the house voice rules
tests/               pytest, offline
```

## Development

```bash
pip install -e ".[app,dev]"
pytest -q
python scripts/voice_check.py
python scripts/export_web_data.py   # after changing a list or a study
cd web && npm install && npm test
```

## Licence

MIT. See [LICENSE](LICENSE).

Built on [Zeeschuimer](https://github.com/digitalmethodsinitiative/zeeschuimer) from the Digital Methods Initiative, with NLTK, pandas, scikit-learn, Pillow, Altair and Streamlit, and in the browser franc, SheetJS and js-yaml.
