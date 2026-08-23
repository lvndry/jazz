# Hero demo for the README — records docs/assets/demo.gif
#
# Record:   brew install vhs && vhs docs/assets/demo.tape
# Rules:    one take, a real run, no staging. If the run is slow, raise the
#           final Sleep rather than cutting before the cost line — the cost
#           line IS the money shot.
#
# The flow below is one of the three guaranteed-wow prompts (works with zero
# extra keys on a fresh install). Swap in the git-review prompt if recording
# inside a repo makes a better take.

Output docs/assets/demo.gif

Set FontSize 18
Set Width 1100
Set Height 640
Set Padding 16
Set TypingSpeed 40ms

Type "jazz"
Enter
Sleep 4s

Type "build me a packing-list web app for a week of hiking"
Enter

# Agent plans, writes the page, reports cost. Generous wait: trim dead time
# in post if needed (vhs renders faithfully; gifsicle can cut frames), but
# never trim the cost line at the end.
Sleep 30s

Sleep 3s
