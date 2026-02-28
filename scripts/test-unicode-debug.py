#!/usr/bin/env python3
"""
Debug helper: reprints specific batches from test-unicode.py one group at a
time so failed batches can be narrowed down to the offending character group.

Usage:
    python3 scripts/test-unicode-debug.py 2 4
"""

import subprocess
import sys

# Must stay in sync with test-unicode.py
BATCH_TARGET = 400

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
    ("CJK symbols",     "〃〄々〆〇〈〉《》「」『』【】〔〕〖〗〘〙〚〛〜〝〞〟〠〡〢〣〤〥〦〧〨〩〪〭〮〯〫〬"),
]


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


def try_print(markup):
    result = subprocess.run(
        ["./receiptd", "print", markup],
        capture_output=True, text=True
    )
    return result.returncode == 0, result.stdout.strip()


def print_group(label, chars, group_num, total):
    markup = (
        f"[align: left][bold: on]Group {group_num}/{total}: {label}[bold: off]\n"
        f"{chars}\n"
        f"[feed: 2]"
    )
    ok, out = try_print(markup)
    status = "OK" if ok else "FAIL"
    print(f"  [{status}] {label} ({len(chars)} chars)")
    if not ok:
        print(f"         ^ cputil rejected this group")
    return ok


if __name__ == "__main__":
    target_batches = [int(x) for x in sys.argv[1:]] if sys.argv[1:] else []
    if not target_batches:
        print("Usage: python3 scripts/test-unicode-debug.py <batch_num> [batch_num ...]")
        print("Example: python3 scripts/test-unicode-debug.py 2 4")
        sys.exit(1)

    all_batches = batch_groups(GROUPS, BATCH_TARGET)
    print(f"Total batches: {len(all_batches)}")

    for bn in target_batches:
        if bn < 1 or bn > len(all_batches):
            print(f"Batch {bn} out of range (1–{len(all_batches)})")
            continue

        batch = all_batches[bn - 1]
        print(f"\n── Batch {bn}: {len(batch)} groups ──────────────────")
        for i, (label, chars) in enumerate(batch, 1):
            print_group(label, chars, i, len(batch))

    print("\nDone.")
