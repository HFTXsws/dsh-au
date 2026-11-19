param([string]$Action, [string]$ConfigPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

# Execute the production helper, replacing only OS/UIA boundaries with a synthetic tree.
$helper = Join-Path $PSScriptRoot '../../lib/client-control/helpers/windows-uia.ps1'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($helper, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Production helper contains PowerShell syntax errors.' }
foreach ($statement in $ast.EndBlock.Statements) {
    if ($statement -is [System.Management.Automation.Language.FunctionDefinitionAst]) {
        $definition = $statement.Extent.Text.Replace(
            '[System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)', '(WindowRoot $process)')
        . ([scriptblock]::Create($definition))
    }
}
$fixture = [IO.File]::ReadAllText($ConfigPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
$script:nextId = 0
function Matches($Element, $Condition) {
    if ($Condition -is [System.Windows.Automation.PropertyCondition]) {
        if ($Condition.Property -eq [System.Windows.Automation.AutomationElement]::ControlTypeProperty) {
            return $Element.Current.ControlType.Id -eq $Condition.Value
        }
        if ($Condition.Property -eq [System.Windows.Automation.AutomationElement]::NameProperty) {
            return [string]::Equals($Element.Current.Name, $Condition.Value, [StringComparison]::Ordinal)
        }
        if ($Condition.Property -eq [System.Windows.Automation.AutomationElement]::AutomationIdProperty) {
            return [string]::Equals($Element.Current.AutomationId, $Condition.Value, [StringComparison]::Ordinal)
        }
        throw 'Unsupported UIA property in fixture.'
    }
    if ($Condition -is [System.Windows.Automation.AndCondition]) {
        foreach ($part in $Condition.GetConditions()) {
            if (-not (Matches $Element $part)) { return $false }
        }
    }
    if ($Condition -is [System.Windows.Automation.AndCondition]) { return $true }
    if ($Condition -eq [System.Windows.Automation.Condition]::TrueCondition) { return $true }
    throw 'Unsupported UIA condition in fixture.'
}
function Descendants($Element) {
    foreach ($child in $Element.Children) {
        # UIA FindAll(TrueCondition) searches RawView; only ControlChildren filters control nodes.
        if ($child.QueryVisible) { $child }
        Descendants $child
    }
}
function Node([string]$Type, [string]$Name = '', [object[]]$Children = @(), [bool]$Control = $true) {
    $script:nextId++
    $node = [pscustomobject]@{
        Current = [pscustomobject]@{
            ControlType = [System.Windows.Automation.ControlType]::$Type
            Name = $Name; AutomationId = ''; ClassName = ''; IsOffscreen = $false; IsEnabled = $true
            IsControlElement = $Control
        }
        Id = $script:nextId; Parent = $null; Children = @($Children); Pattern = $null; QueryVisible = $true
    }
    foreach ($child in $Children) { $child.Parent = $node }
    $node | Add-Member ScriptMethod GetRuntimeId { return @(42, $this.Id) }
    $node | Add-Member ScriptMethod FindAll {
        param($Scope, $Condition)
        return ,@(Descendants $this | Where-Object { Matches $_ $Condition })
    }
    $node | Add-Member ScriptMethod FindFirst {
        param($Scope, $Condition)
        return @(Descendants $this | Where-Object { Matches $_ $Condition }) | Select-Object -First 1
    }
    $node | Add-Member ScriptMethod GetCurrentPattern {
        param($Pattern)
        if ($null -eq $this.Pattern) { throw 'Fixture forbids invoking any UI action.' }
        return $this.Pattern
    }
    return $node
}
function ControlChildren($Element) {
    foreach ($child in $Element.Children) {
        if ($child.Current.IsControlElement) { $child } else { ControlChildren $child }
    }
    # Model Chromium virtual roots: a ControlView sibling walk can escape to a hint,
    # while RawChildren remains bounded. Production must not use this for raw bodies.
    if (-not $Element.QueryVisible -and $null -ne $Element.Parent) {
        $following = $false
        foreach ($sibling in $Element.Parent.Children) {
            if ($following -and $sibling.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text) { $sibling; break }
            if ($sibling.Id -eq $Element.Id) { $following = $true }
        }
    }
}
function RawParent($Element) { return $Element.Parent }
function RawChildren($Element) { return $Element.Children }
function ClaudeWindow { return [pscustomobject]@{ Id = 123; StartTime = [datetime]'2026-01-01'; MainWindowHandle = 456 } }
function WindowRoot($Process) { return $script:root }

$titleNodes = @()
if ($fixture.Case -ne 'missing-title') { $titleNodes += (Node Text $fixture.Title @((Node Button ($fixture.Title + ', rename session')))) }
if ($fixture.Case -eq 'duplicate-title') { $titleNodes += (Node Text $fixture.Title) }
if ($fixture.Case -eq 'raw-duplicate-title') { $titleNodes += (Node Text $fixture.Title @() $false) }
if ($fixture.Case -eq 'hidden-title') { $titleNodes[0].Current.IsOffscreen = $true }
$tools = Node ToolBar 'Session tools' $titleNodes
$sidebar = Node Group 'Sidebar' @((Node Text $fixture.Title), (Node Button $fixture.Title))
$human = switch ($fixture.Case) {
    'wrong-human' { 'different question' }
    'truncated-human' { $fixture.LastUser.Substring(0, 30) }
    'truncated-complete-human' { $fixture.LastUser.Substring(0, 30) }
    default { $fixture.LastUser }
}
$answer = if ($fixture.Case -eq 'wrong-reply') { 'different response' } else { $fixture.PreviousReply }
$humanBody = if ($fixture.Case -eq 'truncated-human') {
    $human + ' different hidden continuation'
} elseif ($fixture.Case -eq 'wrong-human') {
    $human
} else { $fixture.LastUserRendered }
$humanText = Node Text $humanBody
if ($fixture.Case -eq 'nested-human-text') { $humanText = Node Text '' @($humanText) }
$humanContainer = Node Group '' @($humanText) $false
$humanContainer.QueryVisible = $false
$humanContainer.Current.AutomationId = '_r_dynamic_' + $fixture.SourceUserUuid
if ($fixture.Case -eq 'missing-user-uuid') { $humanContainer.Current.AutomationId = '' }
if ($fixture.Case -eq 'wrong-user-uuid') { $humanContainer.Current.AutomationId = '_r_dynamic_ffffffff-ffff-4fff-8fff-ffffffffffff' }
$humanChildren = @((Node Text ('You said: ' + $human)), $humanContainer)
if ($fixture.Case -eq 'duplicate-user-uuid') {
    $duplicateBody = Node Group '' @((Node Text $humanBody)) $false
    $duplicateBody.Current.AutomationId = $humanContainer.Current.AutomationId
    $humanChildren += $duplicateBody
}
if ($fixture.Case -in @('truncated-human', 'truncated-complete-human')) {
    # The clipped UI still exposes its complete raw body; Inspect must not press Show more.
    $humanChildren += (Node Text 'Expand message'), (Node Button 'Show more')
}
$roleSummary = Node Text ('Claude responded: ' + $answer)
$roleSummary.Current.ClassName = 'sr-only select-none'
$paragraph = Node Group '' @((Node Text $answer)) $false
if ($fixture.Case -in @('inline-reply', 'changed-inline-reply')) {
    $reference = Node Button 'file.cs'
    $reference.Current.ClassName = 'prose-link extra-style'
    $tail = if ($fixture.Case -eq 'changed-inline-reply') { '(-2)' } else { '(-1)' }
    $paragraph = Node Group '' @($reference, (Node Text '' @((Node Text $tail)))) $false
}
$status = Node Group '' @((Node Text 'tool-only pollution'), (Node Button 'View tool output'), (Node Separator))
$status.Current.ClassName = if ($fixture.Case -eq 'status-token-near-miss') { 'group/status-extra' } else { 'group/status extra-style' }
$replyChildren = @($roleSummary, $paragraph, $status)
if ($fixture.Case -in @('reply-list', 'changed-list-depth')) {
    $ordered = Node List '' @((Node ListItem '' @((Node Text '1. '), (Node Text 'one'))))
    $inner = Node List '' @((Node ListItem '' @((Node Text ([string][char]0x25e6 + ' ')), (Node Text 'inner'))))
    $outerChildren = @((Node Text ([string][char]0x2022 + ' ')), (Node Text 'outer'), $inner, (Node Text 'tail'))
    if ($fixture.Case -eq 'changed-list-depth') {
        $outerChildren = @((Node Text ([string][char]0x2022 + ' ')), (Node Text 'outer inner tail'))
    }
    $unordered = Node List '' @((Node ListItem '' $outerChildren))
    $replyChildren = @($roleSummary, $ordered, $unordered, (Node Separator), (Node Group '' @((Node Text 'done')) $false), $status)
}
if ($fixture.Case -eq 'unknown-reply-action') { $replyChildren += (Node Button 'Unknown body action') }
if ($fixture.Case -eq 'unlogged-reply-note') {
    $replyChildren += (Node Text 'claude-retry-host'), (Node Text 'synthetic unlogged startup note')
}
$replyRow = Node Group '' $replyChildren $false
$replyRow.QueryVisible = $false
$replyRow.Current.ClassName = 'group/message-row flex-col'
$replyRow.Current.AutomationId = '_r_dynamic_chatcmpl-fixture'
if ($fixture.Case -eq 'missing-reply-id') { $replyRow.Current.AutomationId = '' }
if ($fixture.Case -eq 'wrong-reply-id') { $replyRow.Current.AutomationId = '_r_dynamic_chatcmpl-foreign' }
$assistantChildren = @($replyRow, (Node Text 'outside raw body hint'))
if ($fixture.Case -eq 'duplicate-reply-id') { $assistantChildren += $replyRow }
$messages = Node Group 'Chat messages' @(
    (Node Group 'Message 1' $humanChildren),
    (Node Group 'Message 2' $assistantChildren)
)
$pathLabel = if ($fixture.Case -eq 'wrong-project') { 'Game Build F:\Other' } else { 'Game Build F:\Projects' }
$environmentChildren = @((Node Button 'Environment'), (Node Button $pathLabel), (Node Button 'SampleProject'))
if ($fixture.Case -eq 'duplicate-project') { $environmentChildren += (Node Button $pathLabel) }
$details = Node Group 'Session details' @(
    (Node Group 'Environment' $environmentChildren),
    (Node Group 'Outputs' @((Node Button 'Outputs'), (Node List '' @((Node ListItem 'generated.cs'))))),
    (Node Group 'Changes' @((Node Button 'Changes'), (Node List '' @((Node ListItem 'master')))))
)
$emptyDock = $fixture.Case.StartsWith('empty-dock-', [StringComparison]::Ordinal)
$draft = switch ($fixture.Case) {
    'draft' { 'private unsent draft' }
    'linebreak-draft' { "`n`n" }
    'prepared-send' { $fixture.Prompt }
    'empty-dock-draft' { 'private unsent draft' }
    'empty-dock-linebreak-draft' { "`n`n" }
    'empty-dock-prepared-send' { $fixture.Prompt }
    default { if ($emptyDock) { "`n" } else { '' } }
}
$editor = Node Edit 'Prompt' @((Node Text $draft))
$editor.Pattern = [pscustomobject]@{ Current = [pscustomobject]@{ Value = $draft; IsReadOnly = $false } }
$editor.Pattern | Add-Member ScriptMethod SetValue { throw 'Fixture forbids changing any draft.' }
if ($fixture.Case -eq 'readonly') { $editor.Pattern.Current.IsReadOnly = $true }
if ($fixture.Case -eq 'hidden-prompt') { $editor.Current.IsOffscreen = $true }
$attachments = @()
if ($fixture.Case -eq 'attachment') { $attachments += (Node Image 'pending.png') }
if ($fixture.Case -eq 'preview') { $attachments += (Node Hyperlink 'preview') }
if ($fixture.Case -eq 'unknown-action') { $attachments += (Node Button 'Remove uploaded file') }
if ($fixture.Case -eq 'raw-attachment') { $attachments += (Node Image 'pending.png' @() $false) }
if ($emptyDock) {
    # 2026-11-08 renderer: ignored rounded shell directly inside the approval dock;
    # only the later margin ancestor contains history/details, and no Send exists.
    $adds = @((Node Button 'Add'))
    if ($fixture.Case -eq 'empty-dock-missing-add') { $adds = @() }
    if ($fixture.Case -eq 'empty-dock-duplicate-add') { $adds += (Node Button 'Add') }
    if ($fixture.Case -eq 'empty-dock-unqueryable-duplicate-add') {
        $rawAdd = Node Button 'Add' @() $false
        $rawAdd.QueryVisible = $false
        $adds += $rawAdd
    }
    $shellChildren = @((Node Group '' @($editor) $false)) + $adds + @((Node Group '' @() $false))
    if ($fixture.Case -eq 'empty-dock-stop-only') { $shellChildren += (Node Button 'Stop') }
    if ($fixture.Case -eq 'empty-dock-unqueryable-send') {
        # A RawView Send name remains disqualifying even when FindAll cannot see it.
        $rawSend = Node Text 'Send' @() $false
        $rawSend.QueryVisible = $false
        $shellChildren += $rawSend
    }
    $shell = Node Group '' $shellChildren $false
    $shell.Current.ClassName = 'rounded-composer extra-style'
    if ($fixture.Case -eq 'empty-dock-rounded-class-near-miss') { $shell.Current.ClassName = 'rounded-composer-extra' }
    if ($fixture.Case -eq 'empty-dock-missing-rounded-class') { $shell.Current.ClassName = '' }
    $dockChild = $shell
    if ($fixture.Case -eq 'empty-dock-indirect-parent') { $dockChild = Node Group '' @($shell) $false }
    # The toolbar is outside the rounded shell but inside the verified dock.
    $dockChildren = @($dockChild, (Node Group '' @(
        (Node Button 'Model: test'), (Node Button 'Bypass permissions'), (Node Button 'Usage: 0%')
    ) $false))
    if ($fixture.Case -eq 'empty-dock-attachment') { $dockChildren += (Node Image 'pending.png' @() $false) }
    if ($fixture.Case -eq 'empty-dock-unqueryable-attachment') {
        $rawImage = Node Image 'pending.png' @() $false
        $rawImage.QueryVisible = $false
        $dockChildren += $rawImage
    }
    if ($fixture.Case -eq 'empty-dock-unknown-action') { $dockChildren += (Node Button 'Remove uploaded file') }
    $dockType = if ($fixture.Case -eq 'empty-dock-wrong-parent-type') { 'Pane' } else { 'Group' }
    $dock = Node $dockType '' $dockChildren $false
    $dock.Current.ClassName = 'group/approval-dock extra-style'
    if ($fixture.Case -eq 'empty-dock-dock-class-near-miss') { $dock.Current.ClassName = 'group/approval-dock-extra' }
    if ($fixture.Case -eq 'empty-dock-missing-dock-class') { $dock.Current.ClassName = '' }
    if ($fixture.Case -eq 'empty-dock-root-stop') { $dock.Current.Name = 'Stop' }
    $marginChildren = @($messages, $details, $dock)
    # The same margin leaf must remain unsafe when Chromium omits it from FindAll.
    if ($fixture.Case -in @('empty-dock-sibling-preview', 'empty-dock-unqueryable-sibling-preview')) {
        $preview = Node Hyperlink 'preview' @() $false
        if ($fixture.Case -eq 'empty-dock-unqueryable-sibling-preview') { $preview.QueryVisible = $false }
        $marginChildren += $preview
    }
    if ($fixture.Case -in @('empty-dock-sibling-attachment', 'empty-dock-unqueryable-sibling-attachment')) {
        $attachment = Node Image 'sibling-pending.png' @() $false
        if ($fixture.Case -eq 'empty-dock-unqueryable-sibling-attachment') { $attachment.QueryVisible = $false }
        $marginChildren += $attachment
    }
    $primaryChildren = @((Node Group '' $marginChildren $false))
} else {
    $send = Node Button 'Send'
    $composer = Node Group '' @(
        (Node Group '' @((Node Group '' @($editor) $false)) $false),
        (Node Button 'Add'), (Node Group '' $attachments), (Node Group '' @($send) $false),
        (Node Group '' @((Node Button 'Model: test'), (Node Button 'Bypass permissions')) $false)
    ) $false
    if ($fixture.Case -eq 'outer-attachment') {
        $composer = Node Group '' @($composer, (Node Image 'outer-pending.png')) $false
    }
    $primaryChildren = @($messages, $details, $composer)
}
if ($fixture.Case -eq 'duplicate-prompt') { $primaryChildren += (Node Edit 'Prompt') }
if ($fixture.Case -eq 'raw-duplicate-prompt') { $primaryChildren += (Node Edit 'Prompt' @() $false) }
if ($fixture.Case -eq 'sibling-attachment') { $primaryChildren += (Node Image 'sibling-pending.png' @() $false) }
$primary = Node Group 'Primary pane' $primaryChildren
$document = Node Document ($fixture.Title + ' - Claude Code') @($tools, $sidebar, $primary)
$document.Current.AutomationId = 'RootWebArea'
$blank = Node Document ''
$blank.Current.AutomationId = 'RootWebArea'
$documents = @($blank, $document)
if ($fixture.Case -eq 'missing-document') { $documents = @($blank) }
if ($fixture.Case -eq 'hidden-document') { $document.Current.IsOffscreen = $true }
if ($fixture.Case -eq 'duplicate-document') { $documents += $document }
$script:root = Node Window 'Claude' $documents

# The real dispatch block validates fingerprints/drafts and performs no side effect for Inspect.
$dispatch = @($ast.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.TryStatementAst] })
if ($dispatch.Count -ne 1) { throw 'Production dispatch block is missing or ambiguous.' }
. ([scriptblock]::Create($dispatch[0].Extent.Text))
