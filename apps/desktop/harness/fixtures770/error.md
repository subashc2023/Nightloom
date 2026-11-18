A page with a mistake in it, a remote load, and a kit name that does not exist:

```html page Broken on purpose
<p>This paragraph drew; the chart below it did not.</p>
<img src="https://example.com/logo.png" alt="">
<script src="kit:d3"></script>
<script>drawTheChart(undefinedThing);</script>
```

And a plain block, which stays code:

```html
<p>shown, never run</p>
```
