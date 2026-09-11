# Extraction fixtures

Sections extracted by `src/extract/` from public arXiv PDFs, saved so step 7 can
iterate on prompts without re-parsing a PDF each time. Regenerate them whenever
extraction changes — a stale fixture is worse than none.

| fixture | arXiv | path | columns | sections |
| --- | --- | --- | --- | --- |
| `adam.json` | [1412.6980](https://arxiv.org/abs/1412.6980) | headings | 1 | 10 |
| `attention.json` | [1706.03762](https://arxiv.org/abs/1706.03762) | bookmarks | 1 | 22 |
| `bert.json` | [1810.04805](https://arxiv.org/abs/1810.04805) | headings | 2 | 19 |
| `gpt3.json` | [2005.14165](https://arxiv.org/abs/2005.14165) | bookmarks | 1 | 32 |
| `graphsage.json` | [1706.02216](https://arxiv.org/abs/1706.02216) | bookmarks | 1 | 13 |
| `instructgpt.json` | [2203.02155](https://arxiv.org/abs/2203.02155) | bookmarks | 1 | 19 |
| `resnet.json` | [1512.03385](https://arxiv.org/abs/1512.03385) | headings | 2 | 12 |
| `rnd.json` | [1810.12894](https://arxiv.org/abs/1810.12894) | bookmarks | 1 | 18 |
| `roberta.json` | [1907.11692](https://arxiv.org/abs/1907.11692) | headings | 2 | 25 |
| `vgg.json` | [1409.1556](https://arxiv.org/abs/1409.1556) | bookmarks | 1 | 16 |
| `vit.json` | [2010.11929](https://arxiv.org/abs/2010.11929) | bookmarks | 1 | 13 |

`path` is which extraction route produced them: `bookmarks` from the PDF's own
outline, `headings` from the text-layer heuristics. Both are exercised here, and
both column layouts.

These are a stand-in for the user's own reading list, which step 6 asks for; they
were chosen to span two-column and single-column templates and both extraction
paths. Worth re-checking against real reading-list papers in the viewer.
