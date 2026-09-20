# Monk-E Bars

**Corpus and account analysis of social media posts captured with [Zeeschuimer](https://github.com/digitalmethodsinitiative/zeeschuimer).**

Monk-E Bars answers two questions about the same capture.

**How is a subject discussed.** The words that dominate, the vocabulary that separates high-engagement posts from low, the hashtags that travel together, the thematic layers of a framework, and the colour palettes of the imagery.

**Which accounts are posting.** One row per account, classified by what it is and ranked by its reach, exported as a spreadsheet to work from.

It grew out of a media-studies thesis on the açaí bowl and was generalised, so a study is one small YAML file and the same pipeline serves any subject in any language.

## Install

```bash
git clone https://github.com/StudioMonk-E/monke-bars.git
cd monke-bars
python -m venv .venv && source .venv/bin/activate
pip install -e ".[app]"
```

## Run

```bash
streamlit run app/streamlit_app.py
```

Drop a capture on the page. The platform is read out of the file, so nothing has to be chosen first. A command line exists for scripted runs:

```bash
monke-bars analyze --platform instagram --config configs/acai.yaml \
    --outdir runs/acai "#acaibowl_foryou.ndjson"
```

## What it reads

| Source | Status |
|---|---|
| Instagram, via Zeeschuimer | supported |
| TikTok, via Zeeschuimer | supported |
| CSV, TSV, Excel | supported, needs a column of post text |
| X, Reddit | scaffolds with field maps, see [docs/ROADMAP.md](docs/ROADMAP.md) |

Zeeschuimer stamps `source_platform` on every record, so the adapter is selected from the file. A spreadsheet needs only post text; likes, comments and dates are matched by column name where they exist, and the matching can be corrected before the run. Two captures from different platforms are refused in one analysis, since pooling them would rank two engagement scales against each other.

## The analysis

**Keyness.** Raw frequency describes what a corpus is about, and both ends of one usually return much the same words. On the açaí corpus the top and bottom tiers share seven of their top fifteen, both led by *bowl*. Dunning log-likelihood compares one tier against another and surfaces what is over-used there, which is what supports a comparative claim. A log-ratio effect size sits beside it, because log-likelihood alone rewards sheer frequency.

**Findings.** Every statement a corpus supports on its own is generated and printed under its own heading. The tool writes no interpretation. A study config may carry one `claim` line, which prints above the evidence attributed to its author, so a reader never has to guess which sentences came from the data.

**Thematic layers.** Word lists encoding a framework, counted per tier as a share of that tier's vocabulary. Beside them sits unsupervised topic modelling over the same corpus. Dictionary methods carry a standing objection, that the lexicon encodes the conclusion, and running both in the same view answers it in practice.

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

One YAML file. [configs/template.yaml](configs/template.yaml) is a commented starting point, written as fitness in Spanish to show that nothing about the machinery is wedding-shaped or Dutch.

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

**Language detection is imperfect on short captions**, and closely related languages defeat it. Signals with veto words exist for that case, and Afrikaans against Dutch is the worked example.

**A language filter removes a great deal.** On the açaí corpus, keeping English only removed 196 of 399 posts, which is 49 percent of the capture. Portuguese-language posts are absent from every figure in that study, and on a Brazilian ingredient that is a scoping decision with consequences.

## Data and privacy

Captures hold personal data, and the account list holds more of it: named individuals, profile links, engagement, in a file built to be shared. Handle it under the same rules as any other personal data, and check that a scrape is permitted before running one for commercial purposes.

`.gitignore` keeps captures and exported workbooks out of version control. The repository carries no scraped data.

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
app/streamlit_app.py the dashboard
configs/             studies
scripts/voice_check.py  prose check against the house voice rules
tests/               pytest, offline
```

## Development

```bash
pip install -e ".[app,dev]"
pytest -q
python scripts/voice_check.py
```

## Licence

MIT. See [LICENSE](LICENSE).

Built on [Zeeschuimer](https://github.com/digitalmethodsinitiative/zeeschuimer) from the Digital Methods Initiative, with NLTK, pandas, scikit-learn, Pillow, Altair and Streamlit.
