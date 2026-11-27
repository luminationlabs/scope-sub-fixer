-- "Scope Subs": double-click to check the library for new titles and fix the
-- ones that need it, in a Terminal window (scripts/scope-subs.sh does the work).
--
-- Build it into an app on the Desktop of the machine scope-sub is deployed to:
--   osacompile -o ~/Desktop/"Scope Subs.app" scripts/scope-subs.applescript
-- The script path below is where scripts/deploy.sh installs the package.

set runner to POSIX path of (path to home folder) & "Scripts/scope-sub/npm-global/lib/node_modules/scope-sub/scripts/scope-subs.sh"

tell application "Terminal"
	activate
	do script "/bin/bash " & quoted form of runner
end tell
