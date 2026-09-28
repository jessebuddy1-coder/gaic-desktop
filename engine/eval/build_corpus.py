"""Build one unified human-vs-AI text corpus from the cloned public datasets.

Every record: id, text, label (0 human, 1 AI), corpus, domain, generator,
variant, train_ok (license permits training), group (for leave-group-out CV).
Variants: "plain" (main task), "humanized" (AI text run through a humanizer or
paraphraser/attack), "ai_polished" (human text rephrased by an LLM; excluded
from binary metrics), "human_edited_ai".
"""
import csv, glob, hashlib, json, os, pickle, re, sys, collections

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "text")
OUT = os.path.join(ROOT, "corpus.jsonl")
csv.field_size_limit(10**9)
records = []
seen = set()

END_RE = re.compile(r'[.!?]["\')\]]?(?=\s|$)')

def trim_to_sentence(text):
    text = text.replace("\r\n", "\n").strip()
    last = None
    for m in END_RE.finditer(text):
        last = m.end()
    if last and last >= 0.6 * len(text):
        return text[:last].strip()
    return text

def add(text, label, corpus, domain, generator, variant="plain", train_ok=True, group=None):
    if not isinstance(text, str):
        return
    text = trim_to_sentence(text)
    if len(text) < 300:
        return
    key = hashlib.sha1(re.sub(r"\s+", " ", text.lower()).encode()).hexdigest()
    if key in seen:
        return
    seen.add(key)
    records.append(dict(id=key[:16], text=text, label=int(label), corpus=corpus,
                        domain=domain, generator=generator, variant=variant,
                        train_ok=bool(train_ok), group=group or corpus))

# ---- HART (truth-mirror, MIT): 2024 models across 4 English domains
for f in sorted(glob.glob(f"{ROOT}/baoguangsheng_truth-mirror/benchmark/hart/*.json")):
    name = os.path.basename(f).split(".")[0]
    if "-" in name:  # non-English news variants
        continue
    for x in json.load(open(f)):
        cs, ls = x["content_source"], x.get("language_source", "")
        gen = cs.split(":", 1)[1] if ":" in cs else "human"
        if cs == "human" and ls == "human":
            add(x["generation"], 0, "hart", name, "human")
        elif cs == "human" and ls.startswith("rephrase"):
            add(x["generation"], 1, "hart", name, ls.split(":", 1)[1], variant="ai_polished")
        elif cs.startswith("machine") and ls.startswith("machine"):
            add(x["generation"], 1, "hart", name, gen)
        elif cs.startswith("machine") and ls == "humanize:human":
            add(x["generation"], 1, "hart", name, gen, variant="human_edited_ai")
        elif cs.startswith("machine") and ls.startswith("humanize"):
            add(x["generation"], 1, "hart", name, gen + "+" + ls.split(":", 1)[1], variant="humanized")

# ---- RAID subset (truth-mirror, MIT): 11 generators, 8 domains, attacks
for f in sorted(glob.glob(f"{ROOT}/baoguangsheng_truth-mirror/benchmark/raid/raid.*.json")):
    for x in json.load(open(f)):
        attack = re.search(r"attack\(([^)]*)\)", x.get("note", "") or "")
        attack = attack.group(1) if attack else "none"
        human = x["content_source"] == "human"
        gen = "human" if human else x["content_source"].split(":", 1)[1]
        variant = "plain" if attack == "none" else "attack:" + attack
        if not human and attack == "paraphrase":
            variant = "humanized"
        add(x["generation"], 0 if human else 1, "raid", x["domain"], gen, variant=variant)

# ---- Non-native TOEFL (truth-mirror copy of Liang et al.): human only (+gpt4 polish)
for x in json.load(open(f"{ROOT}/baoguangsheng_truth-mirror/benchmark/raid/nonnative.test.json")):
    if x["content_source"] == "human":
        add(x["generation"], 0, "toefl", "toefl-nonnative", "human")
    else:
        add(x["generation"], 1, "toefl", "toefl-nonnative", "gpt4", variant="ai_polished")

# ---- Glimpse + Fast-DetectGPT (MIT): original (human) vs sampled (AI)
for base in ["baoguangsheng_glimpse/exp_main/data", "baoguangsheng_fast-detect-gpt/exp_gpt3to4/data"]:
    for f in sorted(glob.glob(f"{ROOT}/{base}/*.raw_data.json")):
        dom, gen = os.path.basename(f).replace(".raw_data.json", "").split("_", 1)
        d = json.load(open(f))
        for t in d["original"]:
            add(t, 0, "glimpse", dom, "human")
        for t in d["sampled"]:
            add(t, 1, "glimpse", dom, gen)

# ---- ImBD (Apache-2.0): xsum originals vs generations (incl. gpt-4o); polish = ai_polished
for f in sorted(glob.glob(f"{ROOT}/Jiaqi-Chen-00_ImBD/data/*/*/*.raw_data.json")):
    task = f.split("/")[-3]
    gen = f.split("/")[-2]
    dom = os.path.basename(f).split("_")[0]
    d = json.load(open(f))
    if not isinstance(d, dict) or "original" not in d or task == "multilang":
        continue
    for t in d["original"]:
        add(t, 0, "imbd", dom, "human")
    variant = {"generation": "plain", "expand": "plain", "polish": "ai_polished", "rewrite": "ai_polished"}.get(task, "ai_polished")
    for t in d.get("sampled") or d.get("rewritten") or []:
        add(t, 1, "imbd", dom, gen, variant=variant)

# ---- Ghostbuster (CC BY 3.0): essay/reuter/wp human vs ChatGPT/Claude; learner corpora
GB = f"{ROOT}/gb"
for dom in ["essay", "reuter", "wp"]:
    for sub in sorted(os.listdir(f"{GB}/{dom}")):
        if sub in ("prompts",):
            continue
        label = 0 if sub == "human" else 1
        gen = "human" if sub == "human" else ("claude" if sub == "claude" else "chatgpt")
        for p in glob.glob(f"{GB}/{dom}/{sub}/**/*.txt", recursive=True):
            add(open(p, errors="ignore").read(), label, "ghostbuster", dom, gen)
for sub, dom in [("bawe", "bawe-academic"), ("ets", "ets-nonnative"), ("lang8", "lang8-nonnative"),
                 ("pelic", "pelic-nonnative"), ("toefl91", "toefl-nonnative")]:
    for p in glob.glob(f"{GB}/other/{sub}/*.txt"):
        add(open(p, errors="ignore").read(), 0, "ghostbuster", dom, "human")
for p in glob.glob(f"{GB}/other/undetectable/*.txt"):
    add(open(p, errors="ignore").read(), 1, "ghostbuster", "reuter", "chatgpt+undetectable", variant="humanized")

# ---- OUTFOX (Apache-2.0): student essays vs ChatGPT / davinci-003 / flan-t5; attacks
OF = f"{ROOT}/ryuryukke_OUTFOX/data"
for split in ["train", "valid", "test"]:
    for t in pickle.load(open(f"{OF}/common/{split}/{split}_humans.pkl", "rb")):
        add(t, 0, "outfox", "student-essay", "human")
    for gen in ["chatgpt", "text_davinci_003", "flan_t5_xxl"]:
        p = f"{OF}/{gen}/{split}/{split}_lms.pkl"
        if os.path.exists(p):
            for t in pickle.load(open(p, "rb")):
                add(t, 1, "outfox", "student-essay", gen)
for gen in ["chatgpt", "text_davinci_003", "flan_t5_xxl"]:
    p = f"{OF}/dipper/{gen}/test_attacks.pkl"
    if os.path.exists(p):
        for t in pickle.load(open(p, "rb")):
            add(t, 1, "outfox", "student-essay", gen + "+dipper", variant="humanized")
p = f"{OF}/chatgpt/test/test_outfox_attacks.pkl"
if os.path.exists(p):
    for t in pickle.load(open(p, "rb")):
        add(t, 1, "outfox", "student-essay", "chatgpt+outfox", variant="humanized")

# ---- CHEAT (MIT): IEEE abstracts human vs ChatGPT; polish/fusion = ai_polished
CH = f"{ROOT}/botianzhe_CHEAT/data"
for fname, label, variant in [("ieee-init.jsonl", 0, "plain"), ("ieee-chatgpt-generation.jsonl", 1, "plain"),
                              ("ieee-chatgpt-polish.jsonl", 1, "ai_polished"), ("ieee-chatgpt-fusion.jsonl", 1, "ai_polished")]:
    for i, line in enumerate(open(f"{CH}/{fname}")):
        if i >= 3000:
            break
        x = json.loads(line)
        add(x.get("abstract", ""), label, "cheat", "ieee-abstract", "human" if label == 0 else "chatgpt", variant=variant)

# ================= HELD-OUT ONLY (no license => never used for training) =================
DR = f"{ROOT}/NLP2CT_DetectRL/Benchmark/Benchmark_Data"
for f in sorted(glob.glob(f"{DR}/Multi_LLM/*_test.json") + glob.glob(f"{DR}/Direct_Prompt/*_test.json")):
    for x in json.load(open(f)):
        human = x["label"] == "human"
        dt = x["data_type"]
        variant = "plain"
        if not human and dt not in ("direct_prompt",):
            variant = "humanized" if ("paraphrase" in dt or "adversarial" in dt or "SICO" in dt) else "plain"
        dom = {"abstract": "arxiv", "document": "xsum", "story": "writing", "content": "yelp"}.get(dt, "mixed")
        add(x["text"], 0 if human else 1, "detectrl", dom if human else "llm:" + dt, "human" if human else x["llm_type"],
            variant=variant, train_ok=False)
DB = f"{ROOT}/Weixin-Liang_ChatGPT-Detector-Bias/Data_and_Results"
for p in glob.glob(f"{DB}/Human_Data/*_real_*/*.json") + glob.glob(f"{DB}/Human_Data/*_real_*/*.txt"):
    pass
for folder in glob.glob(f"{DB}/Human_Data/*") + glob.glob(f"{DB}/GPT_Data/*"):
    name = os.path.basename(folder)
    is_gpt = "/GPT_Data/" in folder
    if "polished" in name or "simplify" in name:
        continue
    for p in glob.glob(f"{folder}/*.json"):
        try:
            d = json.load(open(p))
        except Exception:
            continue
        items = d if isinstance(d, list) else [d]
        for x in items:
            t = x.get("document") if isinstance(x, dict) else x
            add(t, 1 if is_gpt else 0, "detector-bias", name.rsplit("_", 1)[0], "gpt3" if is_gpt else "human", train_ok=False)
for f in glob.glob(f"{ROOT}/huhailinguist_ArguGPT/data/argugpt/machine-*.csv"):
    for x in csv.DictReader(open(f)):
        if x["model"] in ("gpt-3.5-turbo", "text-davinci-003"):
            add(x["text"], 1, "argugpt", "esl-essay-prompt", x["model"], train_ok=False)

with open(OUT, "w") as fh:
    for r in records:
        fh.write(json.dumps(r) + "\n")
c = collections.Counter((r["corpus"], r["label"], r["variant"] if not r["variant"].startswith("attack") else "attack", r["train_ok"]) for r in records)
for k, v in sorted(c.items()):
    print(k, v)
print("total", len(records))
