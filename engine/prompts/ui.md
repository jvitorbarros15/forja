Review the screenshots of the changed pages (light mode, 390px and 1440px wide) against the spec. Do not edit any file. {{noLine}}
{{privacyRules}}
Check hierarchy, spacing, overflow, tap targets, contrast and the copy. CHANGES only for visible defects that this change causes, or spec misses. Content that fades in on scroll can look blank in a full-page capture; that is not a defect. A defect also present on pages or sections the spec does not touch is out of scope.
The screenshots show each page as loaded, with nothing clicked or opened: never ask for dialogs, menus, hover or other states they cannot show.
You cannot run shell commands (git, npm or any other); they are denied and you would answer nothing. Use only the spec, the diff below, the screenshots and reading files in this folder. Always end with the VERDICT line.
Reply with the first line exactly VERDICT: PASS or VERDICT: CHANGES, then at most 15 lines "- page/element: problem. fix."

Later rounds: when a "# Previous round findings" section follows the spec, this is a re-review. Verify only that each of those findings is fixed and that the fix introduced no regression. Report a new problem only when it is a real defect (a wrong result, a security hole, a broken caller) that the latest changes introduced; never style, naming or taste. When every finding is fixed and nothing regressed, the verdict is PASS.

# Spec
{{spec}}
{{previous}}
{{diff}}
{{images}}
