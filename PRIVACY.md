# Privacy policy — DSH Figma Bridge

Applies to the **DSH Figma Bridge** plugin for Figma and to the local bridge program it
connects to.

## The short version

The plugin sends design data to exactly one place: a program running on your own computer
(`http://localhost:8790`). It does not contact any server operated by the plugin's author. There is
no analytics, no telemetry, no crash reporting, and no account system.

## What the plugin sends, and where

| Destination | What goes there | When |
|---|---|---|
| `http://localhost:8790` (a bridge process on your machine) | The plugin's own status (file name, page name, current selection *count*, supported commands) on every poll | Continuously while the plugin is open |
| `http://localhost:8790` | Results of the commands that program requests: node properties, layer structure, exported images of nodes you selected or named | Only when that program asks |

That address is the plugin's **only** network access. It is declared in the plugin manifest as
`networkAccess.allowedDomains`, and Figma enforces it.

The plugin does not send your file anywhere else, does not read files other than the one it is
running in, and does not transmit anything at all while the bridge is not running.

## What the bridge program does

The bridge is a program you run yourself, on your own machine. It:

- accepts local connections only — it binds loopback addresses (`127.0.0.1` and `::1`) and is not
  reachable from your local network or the internet;
- makes **no outbound network requests of its own**;
- writes logs to its own standard error output, which stays on your machine.

Whatever reads from the bridge — a script, an editor, or a service you configured — is under your
control and covered by that tool's own privacy policy, not this one. If you point such a tool at a
hosted provider, your file's contents are sent to that provider **by that tool**, and you should read
its terms before doing so.

## Data the author receives

None. The author has no server, receives no copy of your designs, and cannot see your usage.

## Data retention

The plugin and bridge keep nothing beyond the current session, except two values the plugin stores
in Figma's own `clientStorage`: the bridge port and a pairing token. Both live in your Figma client
and can be cleared by removing and reinstalling the plugin.

## Contact

Questions about this policy: **silentzyh@163.com**
