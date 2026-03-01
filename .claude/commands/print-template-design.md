You are helping design and iterate on receipt templates for a Star Micronics thermal printer (80mm).

Start by reading the full reference:

```
docs/star-markup.md
```

Then work with the user to:
1. Understand what they want — layout, content, tone
2. Design the markup, explaining key choices
3. Test with `./receiptd print "<markup>"` — see how it looks on paper
4. Iterate based on results

Daemon appends `[feed:3][cut]` — omit `[cut]` from content. 48 chars/line normal, 24 at 2×.
