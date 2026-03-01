package printlib

func init() {
	allItems = append(allItems,
		Item{
			Name:        "html-basic",
			Description: "Classic receipt: header, line items, total, footer",
			Kind:        KindTemplate,
			Mode:        ModeRender,
			Tags:        []string{"receipt", "layout"},
			HTMLFn:      htmlBasic,
		},
		Item{
			Name:        "html-emoji",
			Description: "Emoji in receipt context — only possible via the render path",
			Kind:        KindExample,
			Mode:        ModeRender,
			Tags:        []string{"emoji", "render"},
			HTMLFn:      htmlEmoji,
		},
		Item{
			Name:        "html-gradients",
			Description: "CSS linear/radial gradients — demonstrates dither quality",
			Kind:        KindExample,
			Mode:        ModeRender,
			Tags:        []string{"css", "gradients", "dither"},
			HTMLFn:      htmlGradients,
		},
		Item{
			Name:        "html-tables",
			Description: "Bordered table layout for data-dense receipts",
			Kind:        KindTemplate,
			Mode:        ModeRender,
			Tags:        []string{"receipt", "table", "layout"},
			HTMLFn:      htmlTables,
		},
	)
}

func htmlBasic() string {
	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  width: 576px;
  font-family: monospace;
  font-size: 21px;
  padding: 12px;
  background: white;
  color: black;
}
.header { text-align: center; margin-bottom: 12px; }
.header h1 { font-size: 33px; font-weight: bold; letter-spacing: 2px; }
.header p { font-size: 18px; color: #333; }
.sep { border-top: 2px solid black; margin: 9px 0; }
.sep-thin { border-top: 1px solid #888; margin: 6px 0; }
.row { display: flex; justify-content: space-between; margin: 3px 0; }
.total { font-weight: bold; font-size: 22px; }
.footer { text-align: center; margin-top: 12px; font-size: 16px; color: #555; }
</style>
</head>
<body>
<div class="header">
  <h1>THE RECEIPT SHOP</h1>
  <p>123 Main Street · Anytown</p>
  <p>Tel: 555-0100</p>
</div>
<div class="sep"></div>
<div class="row"><span>Large Vegetable Soup</span><span>£4.50</span></div>
<div class="row"><span>Garlic Bread</span><span>£3.00</span></div>
<div class="row"><span>Olives (side)</span><span>£1.50</span></div>
<div class="row"><span>Still Water 500ml</span><span>£2.00</span></div>
<div class="sep-thin"></div>
<div class="row"><span>Subtotal</span><span>£11.00</span></div>
<div class="row"><span>VAT (20%)</span><span>£2.20</span></div>
<div class="sep"></div>
<div class="row total"><span>TOTAL</span><span>£13.20</span></div>
<div class="sep"></div>
<div class="footer">
  <p>Thank you for dining with us!</p>
  <p>Visit us at thereceiptshop.example</p>
</div>
</body>
</html>`
}

func htmlEmoji() string {
	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  width: 576px;
  font-family: -apple-system, sans-serif;
  font-size: 21px;
  padding: 18px 12px;
  background: white;
  color: black;
}
.header { text-align: center; margin-bottom: 15px; }
.header .title { font-size: 36px; font-weight: bold; }
.sep { border-top: 2px solid black; margin: 12px 0; }
.row { display: flex; justify-content: space-between; align-items: center; margin: 6px 0; }
.emoji { font-size: 27px; margin-right: 9px; }
.label { flex: 1; }
.price { font-variant-numeric: tabular-nums; }
.total { font-weight: bold; font-size: 24px; }
.footer { text-align: center; margin-top: 15px; font-size: 30px; letter-spacing: 4px; }
.thanks { text-align: center; font-size: 20px; margin-top: 9px; }
</style>
</head>
<body>
<div class="header">
  <div class="title">🧾 ORDER RECEIPT 🧾</div>
</div>
<div class="sep"></div>
<div class="row">
  <span><span class="emoji">☕</span><span class="label">Flat White</span></span>
  <span class="price">£3.50</span>
</div>
<div class="row">
  <span><span class="emoji">🥐</span><span class="label">Almond Croissant</span></span>
  <span class="price">£3.00</span>
</div>
<div class="row">
  <span><span class="emoji">🍰</span><span class="label">Lemon Drizzle Cake</span></span>
  <span class="price">£4.00</span>
</div>
<div class="row">
  <span><span class="emoji">🍊</span><span class="label">Fresh OJ</span></span>
  <span class="price">£2.50</span>
</div>
<div class="sep"></div>
<div class="row total">
  <span>✅ TOTAL</span>
  <span>£13.00</span>
</div>
<div class="sep"></div>
<div class="footer">🎉 ✨ 🎊</div>
<div class="thanks">Thanks for visiting! Come back soon.</div>
</body>
</html>`
}

func htmlGradients() string {
	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  width: 576px;
  font-family: monospace;
  font-size: 20px;
  padding: 12px;
  background: white;
  color: black;
}
h2 { text-align: center; font-size: 24px; margin-bottom: 9px; }
.label { font-size: 16px; text-align: center; color: #444; margin: 6px 0 3px; }
.sep { border-top: 1px solid #aaa; margin: 9px 0; }
.grad {
  width: 100%;
  height: 60px;
  border: 1px solid #ccc;
  margin-bottom: 6px;
}
.row2 { display: flex; gap: 6px; margin-bottom: 6px; }
.row2 .grad { flex: 1; height: 60px; }
.radial { background: radial-gradient(circle, white 0%, black 100%); }
.radial2 { background: radial-gradient(circle at top left, white, black); }
</style>
</head>
<body>
<h2>CSS GRADIENT DITHER TEST</h2>
<div class="sep"></div>
<div class="label">Black → White (left to right)</div>
<div class="grad" style="background: linear-gradient(to right, black, white)"></div>
<div class="label">White → Black (left to right)</div>
<div class="grad" style="background: linear-gradient(to right, white, black)"></div>
<div class="label">Black → White → Black</div>
<div class="grad" style="background: linear-gradient(to right, black, white, black)"></div>
<div class="label">Diagonal gradients</div>
<div class="row2">
  <div class="grad" style="background: linear-gradient(45deg, black, white)"></div>
  <div class="grad" style="background: linear-gradient(135deg, black, white)"></div>
</div>
<div class="label">Radial gradients</div>
<div class="row2">
  <div class="grad radial"></div>
  <div class="grad radial2"></div>
</div>
<div class="label">Multi-stop: 5 zones</div>
<div class="grad" style="background: linear-gradient(to right, black 0%, #444 25%, #888 50%, #bbb 75%, white 100%)"></div>
</body>
</html>`
}

func htmlTables() string {
	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  width: 576px;
  font-family: monospace;
  font-size: 20px;
  padding: 12px;
  background: white;
  color: black;
}
h2 { text-align: center; font-size: 24px; margin-bottom: 12px; letter-spacing: 1px; }
table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 15px;
}
th, td {
  border: 1px solid black;
  padding: 4px 7px;
  font-size: 18px;
}
th { background: black; color: white; font-weight: bold; text-align: left; }
tr:nth-child(even) td { background: #eee; }
.right { text-align: right; }
.total-row td { font-weight: bold; border-top: 2px solid black; }
.section { font-size: 16px; font-weight: bold; background: #ddd !important; }
</style>
</head>
<body>
<h2>TABLE LAYOUT TEMPLATE</h2>
<table>
  <tr><th>Item</th><th>Qty</th><th class="right">Price</th><th class="right">Total</th></tr>
  <tr><td>Widget A</td><td>2</td><td class="right">£4.99</td><td class="right">£9.98</td></tr>
  <tr><td>Widget B</td><td>1</td><td class="right">£12.50</td><td class="right">£12.50</td></tr>
  <tr><td>Gadget X</td><td>3</td><td class="right">£2.00</td><td class="right">£6.00</td></tr>
  <tr><td>Doohickey</td><td>1</td><td class="right">£8.75</td><td class="right">£8.75</td></tr>
  <tr class="total-row"><td colspan="3">TOTAL</td><td class="right">£37.23</td></tr>
</table>
<table>
  <tr><th colspan="2">System Status</th></tr>
  <tr><td>Server</td><td>✅ Online</td></tr>
  <tr><td>Queue</td><td>3 jobs</td></tr>
  <tr><td>Printer</td><td>Ready</td></tr>
  <tr><td>Paper</td><td>OK</td></tr>
</table>
</body>
</html>`
}
