The decision you described, as a flow:

```html page Which estimator to use
<pre class="mermaid">
flowchart LR
  A[Sample x1..xn] --> B{Is the density smooth in theta?}
  B -- yes --> C[Log-likelihood]
  C --> D[Differentiate, set to 0]
  D --> E[Check it is a maximum]
  B -- no, support depends on theta --> F[Order statistics]
  F --> G[MLE is max or min of the sample]
  E --> H((Estimator))
  G --> H
</pre>
<script src="kit:mermaid"></script>
<script>
  addEventListener("load", () => setTimeout(async () => {
    let net = "not tried";
    try { await fetch("https://example.com/"); net = "REACHED THE NETWORK"; } catch (e) { net = "fetch blocked"; }
    parent.postMessage({ probe: "mermaid: " + document.querySelectorAll("pre.mermaid svg g.node").length + " nodes drawn; " + net }, "*");
  }, 900));
</script>
```

The uniform case is the right-hand branch: no derivative, just the largest observation.
