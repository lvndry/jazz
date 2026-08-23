# Demo recording for the README — records docs/assets/demo.gif
#
# Record:   vhs docs/assets/demo.tape
# Convert:  keep GIFs at ~1000px wide; if converting a .mov instead, use:
#   ffmpeg -i in.mov -vf "fps=12,scale=1000:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4" out.gif
# Rules:    one take, a real run, no staging; always end on the cost line.
#
# Note: this prompt needs a web_search key and Chrome (for create_pdf) — both
# are everyday-machine dependencies, not fresh-install ones. The README's
# out-of-the-box prompt list is the place for keyless flows; the demo shows
# the everyday assistant at work.

Output docs/assets/demo.gif

Set FontSize 18
Set Width 1100
Set Height 640
Set Padding 16
Set TypingSpeed 40ms

Type "jazz"
Enter
Sleep 4s

Type "search for this weekend's events in my city and put the good ones in a one-page pdf"
Enter

# Search + PDF takes a while; speed the result up in post rather than cutting:
#   ffmpeg -i demo.gif -vf "setpts=PTS/4" fast.gif
Sleep 90s

Sleep 3s
