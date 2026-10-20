# Monk-E Bars

**Corpus and account analysis of social media posts captured with [Zeeschuimer](https://github.com/digitalmethodsinitiative/zeeschuimer).**

Monk-E Bars answers two questions about the same capture.

**How is a subject discussed.** The words that dominate, the vocabulary that separates high-engagement posts from low, the hashtags that travel together, the thematic layers of a framework, and the colour palettes of the imagery.

**Which accounts are posting.** One row per account, classified by what it is and ranked by its reach, exported as a spreadsheet to work from.

It grew out of a media-studies thesis on the açaí bowl and was generalised, so a study is one small YAML file and the same pipeline serves any subject in any language.

## Two ways to run it

**In the browser.** The [`web/`](web) folder is a static site with no server behind it. A dropped capture is read, parsed and language-detected inside the tab, once, and every filter after that works on data already in memory, so a click applies in milliseconds and a capture of several thousand posts stays usable. The file never leaves the machine that opened it.

The interface says what each thing is. Four views, **Overview**, **Words**, **Accounts** and **Posts**, and two kinds of setting kept apart: **Scope** is what is in this session (languages, dates, a view floor) and **Setup** is how the corpus is read (the seed hashtag, the dropped words, the themes, the account types), saved as a **program**. The gym voice is kept to the chrome and to the tier names themselves, which read as what they are: Heavyweight down to Lightweight. Two or three files dropped together are compared side by side.

```bash
cd web && python3 -m http.server 5173
```

Then open `http://localhost:5173`. Any static host serves the same folder.

**As a Python package.** The research instrument: the command line, topic modelling and colour, which the browser cannot do.

```bash
git clone https://github.com/StudioMonk-E/Monk-E-Bars.git
cd Monk-E-Bars
python -m venv .venv && source .venv/bin/activate
pip install -e .
monke-bars analyze --platform instagram --config configs/acai.yaml \
    --outdir runs/acai "#acaibowl_foryou.ndjson"
```

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

**Month by month: a falling baseline, or hits that stopped?** Those are two different problems with two different fixes, and a monthly total cannot tell them apart — a month of steady, unremarkable posts and a month carried by one hit can add up to the same number. The Months view draws both: the median per post, which is what an ordinary post does, and the share of each month carried by its three best posts, which is how much the month rode on its hits. The median is used throughout rather than the mean, because one hit drags a mean up by itself, which is the thing being measured. A month under four posts is drawn hollow, and a month that scored nothing has no share at all rather than a share of zero.

**A missing view count is not zero views.** An Instagram capture mixes Reels, which report plays, with photos and carousels, which report nothing at all. Counting those as zero drags every view median toward the floor, so they are left out of the view figures and the number of them is printed above the table: a month says how many posts it held and how many of those could answer a view question. A month is judged thin on its readable posts rather than on everything posted, and an account whose posts carry no views is left out of the benchmark rather than plotted as a flat line. Likes and comments are treated differently, since every post has them and a zero there is a real zero.

**One capture, several brands.** A capture taken across a set of accounts reads as one account unless the reader says which is theirs, so Scope carries an **Account** filter and the session says when it is pooling. Narrowing applies everywhere — the findings, the vocabulary, the hooks, the months — and the engagement tiers are cut *after* it, so a post is ranked against its own account's posts rather than against a larger account's. The one reading that keeps every account is the benchmark below: narrowing to our own account and then asking whether the others fell would answer itself.

**Comparison groups.** A set of comparison accounts is rarely of one size, and the median of a 113K account and a 3K one answers nothing. Setup carries a group per account, assigned by hand because nothing in a capture says which accounts are a brand's peers, and the benchmark then reads ours against its own group and reports a median for each group beside it. A group too small to carry a median falls back to every other account and says which it used.

**Choosing the measure.** Views where the capture carries them and likes plus comments where it does not, and a switch to force either: TikTok reports views, an Instagram capture often reports none, and likes plus comments is the measure the two platforms share.

**One account against the others.** Whether a fall is ours or everyone's. Each account in a capture is indexed to its own first usable month at 100, because absolute medians cannot answer the question: an account with four times the following has four times the views whatever happens. Each account's change is measured over the same two periods the comparison above uses rather than between its first month and its last, since one freak month at either end would otherwise decide the figure that says whether a fall is ours or everyone's. The comparison reports our change against the *median* change of the others, and says which of the two readings the figures support. A month in which an account posted fewer than three times carries no point at all, since a median over one post is noise and a line drawn through it would show a fall nobody had.

**Platforms stay apart.** Engagement tiers and the hook halves are cut inside each platform. A month cannot be, so where a session holds more than one the Months view says so and asks for a platform to be chosen first: views on Instagram are not views on TikTok, and a median across both is a median of two scales. A spreadsheet can name its own platform in a column, so two native exports read together keep their sides.

**Periods of different lengths.** Once a reader chooses two stretches of months they are rarely the same length, and three months beats two on anything that adds up whatever happened inside them. Posts and totals are therefore given per month beside their totals, the top-three share is reported for the typical month rather than for the period (the top three of a long period is a smaller slice of it), and the comparison says when the two periods differ in length. A period running into the current month is flagged as well: it is being read as a whole month when it is only a part of one.

**Two periods, set against each other.** The monthly charts show a direction; the comparison below them answers what changed. Two stretches of months are picked from the same file — opening on the thirds the reading already describes — and set side by side: posts, median, top-three share and total, the shift in the tag mix in points of share, and keyness in both directions, so the words each period uses that the other does not come out as two facing lists. It is the set comparison with a period in place of a file, which means it needs one export rather than two files split by hand.

**Tag columns from a spreadsheet.** A column the mapper does not claim is kept as a tag rather than dropped, so a sheet tagged by hand — format, type, boosted or not — can be grouped and filtered in the Months view. The tool cannot know what those columns are called, so it keeps whatever is there and lets the reader choose. `media_type` is offered as a built-in dimension beside them, which means a plain capture breaks down by format with no tagging at all. Every median carries the number of posts behind it, because a median over two posts is not a rate.

**Charts, before the counts.** The Overview opens on the shape of the selection: when posts went out and the median engagement of each week beside it, every post ranked strongest to weakest with the tier cuts drawn on it, and, where the capture carries views, reach against response on log scales with the view floor marked. They are inline SVG with no charting library behind them, so they inherit the palette and add nothing to the page weight.

**Hooks.** The first six words of a caption, counted separately from the vocabulary and with the small words left in, because an opening is mostly small words: *stuur dit naar* is three stopwords and it is the entire hook. The corpus is halved by engagement, by rank rather than by the median value, since nearly half a capture can tie and a strict "above the median" test then empties one side. Each opening phrase is reported with the number of posts behind it and how often it lands in the better half, where an opening with no effect scores fifty percent.

**A view floor.** Eighty interactions on six hundred views reads as a thirteen percent rate and outranks a post that thousands of people saw. `min_views` drops those before anything is ranked. A post whose platform reports no view count is never dropped, so an Instagram capture is unaffected, and the floor is named in the corpus finding so the gap between the capture and the corpus is never misread.

**Set comparison.** Two or three captures dropped together stay separate as well as pooled. The comparison measures keyness with the file in place of the tier, which answers what each capture holds that the others do not, beside the words they all share.

**One list from two platforms.** An Instagram and a TikTok capture can be worked in the same session, which is what an outreach list needs: Dutch wedding creators are on both. Engagement tiers are then cut inside each platform, since likes on one are not likes on the other, and an account posting on both comes back as a single account with both platforms named, linked on the platform its strongest post came from. The Excel list carries a `platforms` column and states the limit in its own caveats sheet.

**Stopwords in 33 languages.** Baked into the package, taken from the NLTK corpora, selected automatically from the languages a corpus turns out to hold. The wrong list ruins an analysis in silence: a Dutch corpus read through an English list returns a ranking of Dutch grammar.

**Colour.** Post media downloaded and clustered into dominant-colour palettes per engagement tier, with average hue, saturation and brightness.

## Gains: an account's own followers

Everything above reads a public capture, posts by other people. This reads the opposite: the export a platform hands the person who owns an account, which is the only place follow timestamps exist.

Drop an Instagram "Download your information" export or a TikTok "Download your data" export, as a zip or as its JSON files. The zip is unpacked in the browser and only its JSON is read, so the media stays compressed and a large export stays workable.

Out of it come three things:

- **Gains**, follows by week or by day across the whole period.
- **PRs**, days where follows ran clearly above the account's own rate. A day has to beat the usual rate by half again, stand above its spread, and clear a floor, since two follows on a quiet account is not an event. The rate is a trailing median, so a single viral day does not become the standard every later day is measured against.
- **Stimulus**, every post and every comment the export records, with the follows that arrived in the hours after it, against the baseline for a window that length.

Neither platform records where a follower came from, and no tool can recover it. What this measures is whether follows ran above their usual rate after something happened, which is correlation inside a window: evidence that a comment on a large account worked, never a path anyone traced. Where two actions share a window both rows carry the same follows, and the table says so.

One bias is stated wherever the figures appear: an export lists current followers only, so anyone who followed and later left is absent, and the further back a week sits the thinner it reads.

This part is browser-only. The Python package reads captures; follow timestamps arrive in a different shape and belong where the person owning the account is sitting.

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

A hosted copy holds no data. Every capture is processed in the visitor's own browser and nothing is uploaded, which removes the risk the hosted Python dashboard carried, where an open instance received other people's captures on a shared server. That dashboard has been retired: the browser app replaced it, and keeping two interfaces over one pipeline meant every change had to be made twice.

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
  branding.py        the palette, which viz.py draws from
  viz.py             matplotlib charts for the CLI
web/                 the browser app, a port of the package
  js/                ingest, text, corpus, lexical, accounts, findings, topics, export
                     account.js, gains.js: an account's own export and its follows
  data/              generated by scripts/export_web_data.py
  tests/             node --test, synthetic records
configs/             studies
scripts/export_web_data.py  writes web/data
scripts/voice_check.py      prose check against the house voice rules
tests/               pytest, offline
```

## Development

```bash
pip install -e ".[dev]"
pytest -q
python scripts/voice_check.py
python scripts/export_web_data.py   # after changing a list or a study
cd web && npm install && npm test
```

## Licence

MIT. See [LICENSE](LICENSE).

Built on [Zeeschuimer](https://github.com/digitalmethodsinitiative/zeeschuimer) from the Digital Methods Initiative, with pandas, scikit-learn, Pillow and matplotlib, and in the browser franc, SheetJS, fflate and js-yaml. The stopword lists come from the NLTK corpora and are shipped as data, so the package no longer depends on it.
