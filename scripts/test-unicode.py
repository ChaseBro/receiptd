#!/usr/bin/env python3
"""
Unicode character support test for Star thermal printers.

Prints a representative sample of unicode ranges so you can visually identify
which characters render on your specific printer model. Characters that fail
typically print as dots, squares, or blanks.

Usage:
    python3 scripts/test-unicode.py

Results vary by printer firmware and region. Document your findings in
memory/MEMORY.md.

Tested on: Star TSP100IV (thermal3/80mm) — see memory/MEMORY.md for results.
"""

import subprocess
import sys

# Each entry: (label, characters)
# Labels are printed bold above each character row.
GROUPS = [

    # ── Scripts ─────────────────────────────────────────────────────────────
    ("Latin Ext-A",     "ĀāĂăĄąĆćĈĉĊċČčĎďĐđĒēĔĕĖėĘęĚěĜĝĞğĠġĢģĤĥĦħ"),
    ("Latin Ext-B",     "ƀƁƂƃƄƅƇƈƉƊƋƌƍƎƏƐƑƒƓƔƕƖƗƘƙƚƛƜƝƞƟ"),
    ("Latin Ext",       "àáâäåæçèéêëìíîïðñòóôöùúûüýþÿßø"),
    ("IPA",             "ɐɑɒɓɔɕɖɗɘəɚɛɜɝɞɟɠɡɢɣɤɥɦɧɨɩɪɫɬɭɮɯɰɱɲɳɴɵɶɷɸɹɺɻɼɽɾɿ"),
    ("Modifier ltrs",   "ʰʱʲʳʴʵʶʷʸʹʺʻʼʽʾʿˀˁ˂˃˄˅ˆˇˈˉˊˋˌˍˎˏ"),
    ("Greek",           "αβγδεζηθικλμνξοπρστυφχψωΑΒΓΔΕΖΗΘΛΞΠΣΦΨΩ"),
    ("Cyrillic",        "АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдеж"),
    ("Cyrillic supp",   "ԀԁԂԃԄԅԆԇԈԉԊԋԌԍԎԏԐԑԒԓԔԕԖԗԘԙԚԛԜԝԞԟ"),
    ("Armenian",        "ԱԲԳԴԵԶԷԸԹԺԻԼԽԾԿՀՁՂՃՄՅՆՇՈՉՊՋՌՍՎՏՐՑՒՓՔ"),
    ("Hebrew",          "אבגדהוזחטיכלמנסעפצקרשת"),
    ("Arabic",          "ابتثجحخدذرزسشصضطظعغفقكلمنهوي"),
    ("Coptic",          "ϢϣϤϥϦϧϨϩϪϫϬϭϮϯⲀⲁⲂⲃⲄⲅⲆⲇⲈⲉⲊⲋⲌⲍⲎⲏ"),

    # ── Punctuation & General ────────────────────────────────────────────────
    ("Gen punctuation", "‐‑‒–—―‖‗''‚‛""„‟‥…‧‰‱′″‴‵‶‷‸‹›※‼‽‾"),
    ("Letterlike",      "℀℁ℂ℃℄℅℆ℇ℈℉ℊℋℌℍℎℏℐℑℒℓ℔ℕ℘ℙℚℛℜℝ℞℟℠℡™℣ℤ℥Ω℧ℨ℩KÅℯℰℱ"),

    # ── Numbers & Enclosures ─────────────────────────────────────────────────
    ("Fractions",       "½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞⅐⅑⅒"),
    ("Superscript",     "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ"),
    ("Subscript",       "₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎"),
    ("Circled nums",    "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳"),
    ("Parens nums",     "⑴⑵⑶⑷⑸⑹⑺⑻⑼⑽⑾⑿⒀⒁⒂⒃⒄⒅⒆⒇"),
    ("Period nums",     "⒈⒉⒊⒋⒌⒍⒎⒏⒐⒑⒒⒓⒔⒕⒖⒗⒘⒙⒚⒛"),
    ("Roman nums",      "ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫⅬⅭⅮⅯⅰⅱⅲⅳⅴⅵⅶⅷⅸⅹⅺⅻⅼⅽⅾⅿ"),
    ("Enclosed A-Z",    "ⒶⒷⒸⒹⒺⒻⒼⒽⒾⒿⓀⓁⓂⓃⓄⓅⓆⓇⓈⓉⓊⓋⓌⓍⓎⓏ"),
    ("Enclosed a-z",    "ⓐⓑⓒⓓⓔⓕⓖⓗⓘⓙⓚⓛⓜⓝⓞⓟⓠⓡⓢⓣⓤⓥⓦⓧⓨⓩ"),
    ("Optical CR",      "⑀⑁⑂⑃⑄⑅⑆⑇⑈⑉⑊"),

    # ── Currency ─────────────────────────────────────────────────────────────
    ("Currency",        "€£¥¢₿₹₩₽¤฿₺₴₦₠₡₢₣₤₥₧₨₪₫₭₮₯₰₱₲₳₵₶₷₸₹₺"),

    # ── Box Drawing ──────────────────────────────────────────────────────────
    ("Box single",      "─│┌┐└┘├┤┬┴┼"),
    ("Box double",      "═║╔╗╚╝╠╣╬"),
    ("Box curved",      "╭╮╯╰╴╵╶╷"),
    ("Box mixed S/D",   "╒╓╕╖╘╙╛╜╞╟╡╢╤╥╧╨╪╫"),
    ("Box diagonal",    "╱╲╳╸╹╺╻╼╽╾╿"),

    # ── Blocks & Fills ───────────────────────────────────────────────────────
    ("Blocks",          "█▓▒░▀▄▌▐■□▪▫▬▭▮▯"),
    ("Block elements",  "▰▱▲△▴▵▶▷▸▹►▻▼▽▾▿"),

    # ── Geometric ────────────────────────────────────────────────────────────
    ("Geometric",       "●○◆◇◈◉◊◌◍◎◐◑◒◓◔◕◖◗"),
    ("Shapes",          "▲▼◀▶►◁◂◃◄◅◘◙◚◛◜◝◞◟◠◡◢◣◤◥◦◧◨◩◪◫◬◭◮◯"),
    ("Geo extended",    "⬛⬜⬝⬞⬟⬠⬡⬢⬣⬤⬥⬦⬧⬨⬩⬪⬫⬬⬭⬮⬯"),

    # ── Arrows ───────────────────────────────────────────────────────────────
    ("Arrows",          "→←↑↓↔↕↖↗↘↙↺↻↩↪↬↭↯↰↱↲↳↴↵↶↷↸↹"),
    ("Arrows double",   "⇒⇐⇑⇓⇔⇕⇖⇗⇘⇙⇚⇛⇄⇆⇇⇈⇉⇊⇋⇌⇍⇎⇏⇤⇥⇧⇨⇩⇪"),
    ("Arrows fancy",    "➜➡➤➥➦➧➨➩➪➫➬➭➮➯➰➱"),
    ("Arrows suppl",    "⟵⟶⟷⟸⟹⟺⟻⟼⟽⟾⟿"),
    ("Arrows misc",     "⬀⬁⬂⬃⬄⬅⬆⬇⬈⬉⬊⬋⬌⬍⬎⬏⬐⬑⬒⬓⬔⬕⬖⬗⬘⬙⬚"),

    # ── Math ─────────────────────────────────────────────────────────────────
    ("Math",            "±×÷≤≥≠≈∞√∑∏∂∫∆∇∈∉⊂⊃⊄⊆⊇⊕⊗⊥∥∠∟∡∢∣∤"),
    ("Math suppl",      "⟀⟁⟂⟃⟄⟅⟆⟇⟈⟉⟊⟋⟌⟍⟎⟏⟐⟑⟒⟓⟔⟕⟖⟗⟘⟙⟚⟛⟜⟝⟞⟟"),
    ("Math misc",       "⊀⊁⊄⊈⊉⊊⊋⊌⊍⊎⊏⊐⊑⊒⊓⊔⊘⊙⊚⊛⊜⊝⊞⊟⊠⊡⊢⊣⊤⊦⊧⊨⊩⊪⊫"),
    ("Math letterlike", "ℂℕℤℚℝℙℍℋℌℐℑℒℓ℘ℜℭℨ"),

    # ── Symbols ──────────────────────────────────────────────────────────────
    ("Card suits",      "♠♣♥♦"),
    ("Music",           "♩♪♫♬♭♮♯"),
    ("Zodiac",          "♈♉♊♋♌♍♎♏♐♑♒♓"),
    ("Chess",           "♔♕♖♗♘♙♚♛♜♝♞♟"),
    ("Dice",            "⚀⚁⚂⚃⚄⚅"),
    ("Misc symbols",    "©®™°§¶†‡•…‰′″‼⁉℃℉№℗℠℡☎☏"),
    ("Misc symbols 2",  "⚐⚑⚒⚓⚔⚕⚖⚗⚘⚙⚚⚛⚜⚝⚞⚟⚠⚡⚢⚣⚤⚥⚦⚧⚨⚩⚪⚫⚬⚭⚮⚯"),
    ("Weather",         "☀☁☂☃☄☇☈☉☊☋☌☍☎☏☐☑☒☓"),
    ("Stars/snowflake", "★☆✦✧✩✪✫✬✭✮✯✰✱✲✳✴✵✶✷✸✹✺❄❅❆❇❈❉❊❋"),
    ("Dingbats",        "✈✉✌✍✎✏✒✓✔✗✘❛❜❝❞❡❢❣❤❥❦❧"),
    ("Ornamental",      "❀❁❂❃❖"),

    # ── Technical ────────────────────────────────────────────────────────────
    ("Technical",       "⌀⌁⌂⌃⌄⌅⌆⌇⌈⌉⌊⌋⌌⌍⌎⌏⌐⌑⌒⌓⌔⌕⌖⌗⌘⌙⌚⌛⌜⌝⌞⌟⌠⌡⌢⌣⌤⌥⌦⌧⌨⌫⌬"),
    ("APL",             "⌶⌷⌸⌹⌺⌻⌼⌽⌾⌿⍀⍁⍂⍃⍄⍅⍆⍇⍈⍉⍊⍋⍌⍍⍎⍏⍐⍑⍒⍓⍔⍕⍖⍗⍘⍙⍚⍛⍜⍝⍞⍟⍠⍡⍢⍣⍤⍥"),
    ("Control pics",    "␀␁␂␃␄␅␆␇␈␉␊␋␌␍␎␏␐␑␒␓␔␕␖␗␘␙␚␛␜␝␞␟␠␡"),
    ("Media/UI",        "⏎⏏⏐⏑⏒⏓⏔⏕⏖⏗⏘⏙⏚⏛⏩⏪⏫⏬⏭⏮⏯⏰⏱⏲⏳"),

    # ── Braille ──────────────────────────────────────────────────────────────
    ("Braille 1",       "⠀⠁⠂⠃⠄⠅⠆⠇⠈⠉⠊⠋⠌⠍⠎⠏⠐⠑⠒⠓⠔⠕⠖⠗⠘⠙⠚⠛⠜⠝⠞⠟"),
    ("Braille 2",       "⠠⠡⠢⠣⠤⠥⠦⠧⠨⠩⠪⠫⠬⠭⠮⠯⠰⠱⠲⠳⠴⠵⠶⠷⠸⠹⠺⠻⠼⠽⠾⠿"),

    # ── CJK-adjacent / Halfwidth / Fullwidth ─────────────────────────────────
    ("Halfwidth kana",  "ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝﾞﾟ"),
    ("Fullwidth ASCII", "！＂＃＄％＆＇（）＊＋，－．／０１２３４５６７８９：；＜＝＞？＠ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ"),
    ("CJK symbols",     "〃〄々〆〇〈〉《》「」『』【】〔〕〖〗〘〙〚〛〜〝〞〟〠〡〢〣〤〥〦〧〨〩〪〭〮〯〫〬"),
]


BATCH_TARGET = 400  # chars per print job


def build_markup(groups, batch_num, total_batches):
    lines = [
        "[align: left]",
        f"[bold: on]Unicode Test {batch_num}/{total_batches}[bold: off]",
    ]
    total = 0
    for label, chars in groups:
        lines.append(f"[bold: on]{label}:[bold: off]")
        lines.append(chars)
        total += len(chars)
    lines.append(f"[align: center]({total} chars)")
    lines.append("[feed: 2]")
    return "\n".join(lines), total


def batch_groups(groups, target):
    batches, current, count = [], [], 0
    for g in groups:
        n = len(g[1])
        if count + n > target and current:
            batches.append(current)
            current, count = [], 0
        current.append(g)
        count += n
    if current:
        batches.append(current)
    return batches


def print_markup(markup):
    result = subprocess.run(
        ["./receiptd", "print", markup],
        capture_output=True, text=True
    )
    print(result.stdout.strip())
    if result.returncode != 0:
        print("Error:", result.stderr, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Unicode thermal printer test")
    parser.add_argument("--batch", type=int, metavar="N",
                        help="Print only batch N as a single job (default: print all batches)")
    args = parser.parse_args()

    batches = batch_groups(GROUPS, BATCH_TARGET)
    grand_total = sum(len(g[1]) for g in GROUPS)
    print(f"{len(GROUPS)} groups, {grand_total} chars → {len(batches)} batches\n")

    if args.batch:
        if args.batch < 1 or args.batch > len(batches):
            print(f"Error: batch {args.batch} out of range (1–{len(batches)})")
            sys.exit(1)
        batch = batches[args.batch - 1]
        markup, total = build_markup(batch, args.batch, len(batches))
        print(f"Printing batch {args.batch}/{len(batches)}: {len(batch)} groups, {total} chars")
        print_markup(markup)
    else:
        for i, batch in enumerate(batches, 1):
            markup, total = build_markup(batch, i, len(batches))
            print(f"Batch {i}/{len(batches)}: {len(batch)} groups, {total} chars")
            print_markup(markup)

    print("\nDone — check the printer!")
