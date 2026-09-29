import test from "node:test";
import vm from "node:vm";
import assert from "node:assert/strict";
import { loadScript, appSection, read } from "./helpers.mjs";

const E = loadScript("text-detector.js").AICheckTextEngine;

// Public-domain human prose (Jane Austen, Pride and Prejudice, 1813).
const HUMAN = `It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife. However little known the feelings or views of such a man may be on his first entering a neighbourhood, this truth is so well fixed in the minds of the surrounding families, that he is considered the rightful property of some one or other of their daughters. "My dear Mr. Bennet," said his lady to him one day, "have you heard that Netherfield Park is let at last?" Mr. Bennet replied that he had not. "But it is," returned she; "for Mrs. Long has just been here, and she told me all about it." Mr. Bennet made no answer. "Do you not want to know who has taken it?" cried his wife impatiently. "You want to tell me, and I have no objection to hearing it." This was invitation enough. "Why, my dear, you must know, Mrs. Long says that Netherfield is taken by a young man of large fortune from the north of England; that he came down on Monday in a chaise and four to see the place, and was so much delighted with it, that he agreed with Mr. Morris immediately; that he is to take possession before Michaelmas, and some of his servants are to be in the house by the end of next week."`;
// Written for this test in the stock style of chat-model essays.
const MACHINE = `In today's fast-paced world, technology plays a crucial role in shaping how we live, work, and connect with one another. From smartphones to smart homes, innovative tools have transformed everyday experiences in profound ways. Moreover, the rapid evolution of artificial intelligence has opened up new possibilities for businesses and individuals alike. It is important to note that these advancements also bring significant challenges, including concerns about privacy, security, and the potential impact on employment. Furthermore, as we navigate this ever-evolving landscape, it is essential to strike a balance between embracing innovation and addressing its ethical implications. Ultimately, by fostering collaboration between policymakers, industry leaders, and communities, we can harness the transformative potential of technology while ensuring that its benefits are shared equitably. In conclusion, technology is a powerful force that, when used responsibly, can pave the way for a brighter and more inclusive future for all.`;

test("model is embedded and matches the engine", () => {
  assert.equal(E.model.version, "GAIC Text Model v2 (2026-09)");
  assert.equal(E.model.dense.length, E.DENSE_NAMES.length);
  assert.equal(E.model.lexicon.size, 2500);
  assert.ok(E.model.bands.high > E.model.bands.low);
});

test("every scored document gets a lean, a confidence level, and a consistent AI likelihood", () => {
  const d = E.model.decision;
  assert.ok(d && Number.isFinite(d.threshold));
  let previous = 0;
  for (let logit = -8; logit <= 8; logit += 0.05) {
    const r = E.decide(logit);
    assert.ok(["ai", "human"].includes(r.lean));
    assert.ok(["high", "medium", "low"].includes(r.confidence));
    assert.equal(r.lean === "ai", logit >= d.threshold);
    assert.equal(r.aiLikelihood >= 50, r.lean === "ai");
    assert.ok(r.aiLikelihood >= previous, "AI likelihood is monotone in the logit");
    previous = r.aiLikelihood;
  }
  assert.equal(E.decide(d.aiHigh + 0.01).confidence, "high");
  assert.equal(E.decide(d.threshold).confidence, "low");
  assert.equal(E.analyze(MACHINE).decision.lean, "ai");
});

test("display mapping keeps the 15-85 range and the 34/66 band edges", () => {
  assert.equal(E.displayScore(E.model.bands.low), 34);
  assert.equal(E.displayScore(E.model.bands.high), 66);
  assert.equal(E.displayScore(-50), 15);
  assert.equal(E.displayScore(50), 85);
});

test("scores are deterministic and banded", () => {
  const a = E.analyze(HUMAN), b = E.analyze(HUMAN);
  assert.equal(a.logit, b.logit);
  assert.notEqual(a.band, "several");
  const m = E.analyze(MACHINE);
  assert.equal(m.band, "several");
  assert.ok(m.score >= 66 && m.score <= 85);
});

test("a machine-like section inside human writing is reported with where it starts", () => {
  const mixed = [HUMAN, HUMAN, MACHINE, HUMAN, HUMAN].join("\n\n");
  const a = E.analyze(mixed);
  assert.equal(a.decision.lean, "human", "the document as a whole leans human");
  const s = a.machineLikeSection;
  assert.ok(s, "the pasted section is reported");
  const start = [HUMAN, HUMAN].join(" ").split(/\s+/).filter(Boolean).length + 1;
  assert.ok(s.firstWord >= start - 5 && s.firstWord <= start + 60, `reported from word ${s.firstWord}, pasted at ${start}`);
  assert.ok(s.lastWord > s.firstWord && s.lastWord <= s.totalWords);
  assert.ok(s.opening.startsWith("In today's fast-paced world"), s.opening);
  assert.equal(s.sections, 1);
  // Nothing to report for human writing alone, for text too short to window,
  // or when the whole document already leans AI.
  assert.equal(E.analyze([HUMAN, HUMAN, HUMAN, HUMAN].join("\n\n")).machineLikeSection, null);
  assert.equal(E.analyze(HUMAN).machineLikeSection, null);
  assert.equal(E.analyze([MACHINE, MACHINE, MACHINE].join("\n\n")).machineLikeSection, null);
});

test("hidden characters and look-alike letters are counted, never ordinary text", () => {
  const disguised = MACHINE.replace(/a/g, "а").replace(/(\w)(\w)/g, "$1\u200b$2");
  const d = E.disguiseCounts(disguised);
  assert.ok(d && d.hiddenCharacters > 50 && d.lookalikeLetters > 20, JSON.stringify(d));
  assert.deepEqual({ ...E.analyze(disguised).disguise }, { ...d });
  assert.equal(E.disguiseCounts(HUMAN), null);
  assert.equal(E.disguiseCounts(MACHINE), null);
  // Legitimate uses: Greek letters in science notation, soft hyphens and
  // zero-width joiners from copied web text, emoji sequences, a byte-order mark.
  const legit = "NF-\u03baB signalling and the \u03b1-helix were measured in \u03bcm. " +
    "Co\u00adoperation and re\u00adsearch continued. Family: \ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67. " +
    "\ufeffThe report \u2014 \u201cquoted\u201d \u2014 ends here.";
  assert.equal(E.disguiseCounts(legit), null);
  // Two tricks are not enough for a notice; three are.
  assert.equal(E.disguiseCounts("wo\u200brd and ca\u200bt"), null);
  assert.ok(E.disguiseCounts("wo\u200brd and ca\u200bt and d\u043eg"));
});

test("zero-width characters and look-alike letters do not change the score", () => {
  const disguised = MACHINE
    .replace(/a/g, "а")          // Cyrillic a
    .replace(/ /g, " ​")          // zero-width spaces
    .replace(/o/g, "ο");          // Greek omicron
  assert.ok(Math.abs(E.analyze(disguised).logit - E.analyze(MACHINE).logit) < 1e-9);
});

test("explanations only cite measurements in their standalone direction", () => {
  for (const text of [HUMAN, MACHINE]) {
    const r = E.analyze(text);
    assert.ok(r.aiSignals.length + r.humanSignals.length > 0);
    assert.ok(r.aiSignals.every((s) => typeof s === "string" && s.length > 2));
  }
});

// Short paragraphs written for these tests.
const OTHER_LANGUAGES = {
  spanish: "El pueblo donde crecí estaba al final de un camino de tierra, entre dos colinas cubiertas de olivos. Cada mañana mi abuela se levantaba antes del amanecer para preparar el pan, y el olor llenaba toda la casa. Los domingos íbamos a la plaza, donde los vecinos se reunían para hablar de la cosecha, del tiempo y de los hijos que se habían ido a la ciudad. Yo no entendía entonces por qué todos parecían tan tristes cuando hablaban de ellos. Ahora que vivo lejos, entiendo que lo que más se echa de menos no es el lugar, sino la manera en que el tiempo pasaba allí, despacio y sin prisa.",
  french: "Le petit café au coin de la rue ouvre ses portes à six heures, bien avant que la ville ne se réveille. Le patron, un homme discret qui parle peu, prépare les croissants lui-même et les dispose dans la vitrine avec un soin presque maniaque. Les premiers clients sont toujours les mêmes : deux infirmières qui sortent de leur garde de nuit, un vieux monsieur qui lit le journal du début à la fin, et une étudiante qui révise ses cours en buvant un café noir. Personne ne se parle vraiment, mais tout le monde se salue, et cette politesse tranquille donne au matin quelque chose de rassurant.",
  german: "Als wir im Herbst in die neue Wohnung zogen, war das Treppenhaus noch voller Kartons von den Nachbarn, die gerade ausgezogen waren. Die Wohnung selbst war hell und größer, als wir erwartet hatten, aber die Heizung funktionierte in den ersten Wochen nicht richtig. Jeden Abend saßen wir mit Decken auf dem Sofa und tranken Tee, während draußen der Regen gegen die Fenster schlug. Trotzdem erinnere ich mich gern an diese Zeit, weil wir damals noch nicht wussten, wie schnell sich alles ändern würde, und weil jeder kleine Fortschritt in der Wohnung sich wie ein großer Erfolg anfühlte.",
  portuguese: "Quando cheguei a Lisboa pela primeira vez, a cidade pareceu-me enorme e confusa, cheia de ruas estreitas que subiam e desciam sem nenhuma lógica. Nos primeiros dias perdi-me várias vezes, mas as pessoas eram sempre simpáticas e explicavam o caminho com muita paciência. Aos poucos fui descobrindo os bairros, as pequenas lojas e os cafés onde os mesmos clientes se sentavam todas as tardes. Hoje, depois de tantos anos, ainda gosto de caminhar sem destino pela cidade, porque há sempre uma esquina que eu não conhecia e uma vista que me surpreende.",
  italian: "Mia nonna aveva un piccolo orto dietro la casa, dove coltivava pomodori, zucchine e basilico. Ogni estate passavo lì due mesi interi, e la mattina la aiutavo a raccogliere le verdure prima che il sole diventasse troppo forte. Lei mi raccontava storie della sua giovinezza, della guerra e di come aveva conosciuto il nonno durante una festa del paese. Non sempre capivo tutto, ma mi piaceva ascoltare la sua voce mentre lavoravamo insieme. Ancora oggi, quando sento il profumo del basilico, penso a quelle mattine lente e tranquille.",
  dutch: "Vorige zomer zijn we met de fiets langs de kust van Zeeland gereden. Het weer was wisselend, soms scheen de zon en een uur later regende het weer, maar dat maakte de tocht juist leuk. We sliepen op kleine campings en aten 's avonds meestal vis in een van de dorpjes aan het water. Mijn broer had een oude kaart meegenomen, omdat hij niet op zijn telefoon wilde vertrouwen, en daardoor zijn we een paar keer verkeerd gereden. Toch was het een van de mooiste weken van het jaar, en we willen het volgend jaar zeker nog een keer doen.",
  polish: "Kiedy byłem dzieckiem, każde wakacje spędzałem u dziadków na wsi. Dziadek wstawał bardzo wcześnie i od razu szedł do ogrodu, a babcia przygotowywała śniadanie dla całej rodziny. Po południu chodziliśmy nad jezioro, gdzie kąpaliśmy się aż do wieczora. Nie było tam internetu ani telewizji, ale nigdy się nie nudziłem, bo zawsze było coś do zrobienia. Dziś, kiedy mieszkam w dużym mieście, często myślę o tamtych dniach i o tym, jak prosto wtedy wyglądało życie, i jak mało było nam potrzeba, żeby być szczęśliwym przez całe lato.",
  turkish: "Geçen yıl yaz tatilinde ailemle birlikte Karadeniz'e gittik. Yollar çok uzundu ama manzara o kadar güzeldi ki yorgunluğu hiç hissetmedik. Her sabah küçük bir köyde kahvaltı yaptık ve yerel halkla sohbet ettik. İnsanlar çok misafirperverdi, bize çay ikram ettiler ve bölgenin tarihini anlattılar. Akşamları ise denizin kenarında yürüyüş yapıp günün nasıl geçtiğini konuştuk. Bu tatil bana, bazen en güzel anların plan yapmadan yaşandığını bir kez daha gösterdi ve bir sonraki yaz için de aynı yere gitmeye karar verdik.",
  indonesian: "Setiap pagi, ibu saya bangun sebelum matahari terbit untuk menyiapkan sarapan bagi seluruh keluarga. Ia selalu memasak nasi goreng atau bubur, tergantung pada apa yang ada di dapur. Setelah itu, kami berangkat ke sekolah dengan berjalan kaki karena jaraknya tidak terlalu jauh dari rumah. Di jalan, kami sering bertemu dengan teman-teman dan tetangga yang juga akan pergi bekerja. Sekarang saya tinggal di kota lain, tetapi kebiasaan bangun pagi dan sarapan bersama keluarga masih saya pertahankan sampai hari ini.",
};
// Not in the function-word lists: caught because it has no English.
const FINNISH = "Kesäisin perheemme vietti aina muutaman viikon mökillä järven rannalla. Isä lämmitti saunan joka ilta, ja me lapset uimme niin kauan, että huulet muuttuivat sinisiksi. Äiti keitti kahvia puuhellalla ja paisti pullaa, jonka tuoksu levisi koko pihalle. Päivisin kalastimme, poimimme mustikoita metsästä ja luimme vanhoja sarjakuvalehtiä, joita mökillä oli kokonainen pino. Vaikka mökillä ei ollut sähköä eikä juoksevaa vettä, muistan ne kesät elämäni onnellisimpina aikoina. Nykyään käyn siellä harvemmin, mutta joka kerta tunnen saman rauhan, kun istun laiturilla ja katselen tyyntä järveä illan hämärtyessä ja kuuntelen kaukaa kuuluvaa kaakkurin huutoa.";
const ENGLISH_SAMPLES = {
  austen: HUMAN,
  essay: MACHINE,
  nonNative: "In my opinion, the university students should to work part-time job during they study. First reason is money, because many student have not enough money for pay the rent and the food. Second, when student work, they learn how to manage the time and how to speak with the customers, it is very useful for the future job. For example my cousin was working in the restaurant two years and now he find a good job easy because he have experience. But also there is some problem, if student work too much hours, they are tired and they cannot study good for the exam. So I think it is good idea to work, but only few hours in the week.",
  recipe: "Preheat the oven to 180 degrees and grease a round tin. In a large bowl, whisk the eggs with the sugar until pale and thick, then fold in the flour and a pinch of salt. Melt the butter in a small pan and let it cool for a minute before you stir it into the batter. Pour the mixture into the tin, smooth the top, and bake for about thirty minutes, until a skewer comes out clean. Leave the cake in the tin for ten minutes, then turn it out onto a rack. When it is cold, dust it with icing sugar or spread it with the jam of your choice.",
  quotesSpanish: "My grandmother never learned much English, and she did not need to: everyone in the neighbourhood knew her. When I left for college she held my face in her hands and said, \"No te olvides de dónde vienes, y llama a tu madre todos los domingos.\" It means that I should not forget where I come from, and that I should call my mother every Sunday. I did not always manage the second part. But I have thought about the first part almost every day since, and I think it is the most useful advice anyone has given me, even though at the time I only rolled my eyes and promised to write.",
};

test("text mostly in another language is recognised; English, including non-native English, is not", () => {
  for (const [name, text] of Object.entries(OTHER_LANGUAGES)) {
    const r = E.languageCheck(text);
    assert.equal(r.english, false, name + " " + JSON.stringify(r));
    assert.equal(r.reason, "other-language", name);
  }
  const finnish = E.languageCheck(FINNISH);
  assert.equal(finnish.english, false, JSON.stringify(finnish));
  assert.equal(finnish.reason, "no-english");
  for (const [name, text] of Object.entries(ENGLISH_SAMPLES)) {
    const r = E.languageCheck(text);
    assert.equal(r.english, true, name + " " + JSON.stringify(r));
    assert.equal(r.reason, "");
  }
});

test("disguise tricks cannot turn English into a refusal", () => {
  const lookalikes = { a: "\u0430", e: "\u0435", o: "\u043e", c: "\u0441", p: "\u0440" };
  const disguised = MACHINE.replace(/[aeocp]/g, (ch) => lookalikes[ch]);
  assert.equal(E.languageCheck(disguised).english, true);
  const zeroWidth = MACHINE.split("").join("\u200b");
  assert.equal(E.languageCheck(zeroWidth).english, true);
  // A list with no function words at all reads as no English only when undisguised.
  const list = Array.from({ length: 40 }, (_, i) => (i + 1) + " cup chopped fresh parsley").join("\n");
  assert.equal(E.languageCheck(list).reason, "no-english");
  assert.equal(E.languageCheck(list.replace(/e/g, "\u0435")).english, true);
});

test("the app turns text in another language away before the English model scores it", () => {
  const code = "(function (global) {" +
    appSection("  const MIN_TEXT_CHARACTERS = 1000;", "  function analyticsTrack") +
    appSection("  // ---------- decisive result layer ----------", "  function setCheckButtonLabel") +
    appSection("  const FORMULAIC_PHRASES", "  // ---------- friendly one-liner") +
    "\nglobalThis.analyzeText = analyzeText;\n})(globalThis);";
  const ctx = loadScript("text-detector.js");
  vm.runInContext(code, ctx);
  for (const [name, text] of Object.entries(OTHER_LANGUAGES)) {
    const r = ctx.analyzeText(text + "\n\n" + text);
    assert.equal(r.kind, "error", name);
    assert.equal(r.verdict, "English prose required", name);
    assert.match(r.explain, /mostly another language/);
    assert.equal(r.countsTowardLimit, false);
    assert.equal(r.score, null);
  }
  const finnish = ctx.analyzeText(FINNISH + "\n\n" + FINNISH);
  assert.equal(finnish.verdict, "English prose required");
  assert.match(finnish.explain, /almost none of the common words of English prose/);
  for (const [name, text] of Object.entries(ENGLISH_SAMPLES)) {
    const r = ctx.analyzeText(text + "\n\n" + text);
    assert.equal(r.kind, "text", name + ": " + r.verdict);
  }
});

test("long documents are scored in bounded passages", () => {
  const long = Array.from({ length: 200 }, () => HUMAN).join("\n\n");
  const r = E.analyze(long);
  assert.ok(r.passages <= 64 && r.passages > 1);
});

test("app.js keeps the gates and verdict contract and falls back without the engine", () => {
  const code = "(function (global) {" +
    appSection("  const MIN_TEXT_CHARACTERS = 1000;", "  function analyticsTrack") +
    appSection("  // ---------- decisive result layer ----------", "  function setCheckButtonLabel") +
    appSection("  const FORMULAIC_PHRASES", "  // ---------- friendly one-liner") +
    "\nglobalThis.analyzeText = analyzeText;\n})(globalThis);";

  const withEngine = loadScript("text-detector.js");
  vm.runInContext(code, withEngine);
  const machine = withEngine.analyzeText(MACHINE);
  assert.equal(machine.kind, "text");
  assert.equal(machine.lean, "ai");
  assert.match(machine.verdict, /^Likely AI-written — (high|medium) confidence$/);
  assert.equal(machine.technicalVerdict, "Several formulaic patterns matched");
  assert.equal(machine.metricLabel, "AI likelihood");
  assert.ok(machine.score >= 50 && machine.score <= 99);
  assert.match(machine.explain, /^GAIC's read: this text is likely AI-written/);
  const human = withEngine.analyzeText(HUMAN + " " + HUMAN);
  assert.equal(human.lean, "human");
  assert.ok(human.score < 50);
  const short = withEngine.analyzeText("short");
  assert.equal(short.kind, "error");
  assert.equal(short.score, null);
  assert.equal(short.lean, undefined);

  const withoutEngine = { TextEncoder };
  withoutEngine.globalThis = withoutEngine;
  vm.createContext(withoutEngine);
  vm.runInContext(code, withoutEngine);
  const legacy = withoutEngine.analyzeText(MACHINE);
  assert.equal(legacy.kind, "text");
  assert.ok(legacy.score >= 15 && legacy.score <= 85);
  assert.equal(legacy.confidence, "low");
  assert.match(legacy.verdict, /^Leans (AI|human)-written — low confidence$/);

  const html = read("ai-detector.html");
  assert.ok(html.indexOf('<script src="text-detector.js"></script>') > -1);
  assert.ok(html.indexOf('<script src="text-detector.js"></script>') < html.indexOf('<script src="app.js"></script>'));
});
