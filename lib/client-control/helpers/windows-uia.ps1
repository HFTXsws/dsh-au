param(
    [Parameter(Mandatory = $true)][ValidateSet('Inspect', 'Prepare', 'Send', 'NewOpen', 'NewInspect', 'NewPrepare', 'NewSend')][string]$Action,
    [Parameter(Mandatory = $true)][string]$ConfigPath
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Same([string]$Left, [string]$Right) {
    return [string]::Equals($Left, $Right, [StringComparison]::Ordinal)
}

function SamePath([string]$Left, [string]$Right) {
    try {
        $leftPath = [IO.Path]::GetFullPath($Left).TrimEnd([char[]]@('\', '/'))
        $rightPath = [IO.Path]::GetFullPath($Right).TrimEnd([char[]]@('\', '/'))
        return [string]::Equals($leftPath, $rightPath, [StringComparison]::OrdinalIgnoreCase)
    } catch {
        return $false
    }
}

function Normalize([string]$Text) {
    return [regex]::Replace($Text, '\s+', ' ').Trim()
}

function Condition($Type, [string]$Name) {
    return New-Object System.Windows.Automation.AndCondition(
        (New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $Type)),
        (New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::NameProperty, $Name)))
}

function Unique($Root, $Type, [string]$Name) {
    $items = $Root.FindAll([System.Windows.Automation.TreeScope]::Descendants, (Condition $Type $Name))
    if ($items.Count -ne 1) { throw "Missing or ambiguous control: $Name" }
    return $items.Item(0)
}

# Keep the native tree boundary separate: raw-only wrappers matter for composer isolation.
function ControlChildren($Element) {
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $child = $walker.GetFirstChild($Element)
    while ($null -ne $child) {
        $child
        $child = $walker.GetNextSibling($child)
    }
}

function RawParent($Element) {
    return [System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($Element)
}

function RawChildren($Element) {
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    $child = $walker.GetFirstChild($Element)
    while ($null -ne $child) {
        $child
        $child = $walker.GetNextSibling($child)
    }
}

function HumanContainers($Element, [string]$Uuid, [int]$Depth = 0) {
    if ($Depth -ge 64) { throw 'Human message tree is too deep to verify safely.' }
    # Chromium's ignored body wrapper is absent from FindAll but present in RawView.
    foreach ($child in (RawChildren $Element)) {
        if ($child.Current.ControlType -eq [System.Windows.Automation.ControlType]::Group -and
            $child.Current.AutomationId.EndsWith(('_' + $Uuid), [StringComparison]::Ordinal)) {
            $child
        }
        HumanContainers $child $Uuid ($Depth + 1)
    }
}

function VerifiedHumanBody($Group, $Config) {
    if ($Config.SourceUserUuid -notmatch '^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' -or
        $null -eq $Config.LastUserRendered) {
        throw 'Missing exact human UUID or rendered body; session identity cannot be verified.'
    }
    $containers = @(HumanContainers $Group $Config.SourceUserUuid)
    if ($containers.Count -ne 1) { throw 'Latest human message UUID is missing or ambiguous.' }
    return Normalize ((@(Body $containers[0] $true)) -join ' ')
}

function Body($Element, [bool]$Raw = $false) {
    $info = $Element.Current
    if ($info.ControlType -eq [System.Windows.Automation.ControlType]::ToolBar -or
        $info.ControlType -eq [System.Windows.Automation.ControlType]::StatusBar) { return }
    if ($info.ControlType -eq [System.Windows.Automation.ControlType]::ListItem) {
        if (-not [string]::IsNullOrWhiteSpace($info.Name)) { $info.Name }
        return
    }
    if ($info.ControlType -eq [System.Windows.Automation.ControlType]::Text) {
        if ($info.Name.StartsWith('Claude responded: ', [StringComparison]::Ordinal) -or
            $info.Name.StartsWith('You said: ', [StringComparison]::Ordinal)) { return }
        if (-not [string]::IsNullOrWhiteSpace($info.Name)) { $info.Name; return }
        if (-not $Raw) { return }
    }
    # ControlView sibling traversal can escape an ignored body wrapper and include Show more.
    # RawView stays inside the UUID-bound subtree and keeps nested empty-name text wrappers.
    $children = if ($Raw) { @(RawChildren $Element) } else { @(ControlChildren $Element) }
    foreach ($child in $children) { Body $child $Raw }
}

function EmptyEditor($Context) {
    $value = $Context.Value.Current.Value
    if ($value.Length -eq 0) { return $true }
    if (-not (Same $value ([string][char]10))) { return $false }
    $children = $Context.Input.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition)
    return $children.Count -eq 1 -and
        $children.Item(0).Current.ControlType -eq [System.Windows.Automation.ControlType]::Text -and
        (Same $children.Item(0).Current.Name ([string][char]10))
}

function ClaudeWindow() {
    $windows = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessName -eq 'claude' -and $_.MainWindowHandle -ne 0
    })
    if ($windows.Count -ne 1) { throw 'Claude window is missing or ambiguous.' }
    return $windows[0]
}

function FindNewContext($Config, [bool]$AllowMissing) {
    $process = ClaudeWindow
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
    $documents = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        (New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'RootWebArea')))
    $documents = @($documents | Where-Object { (Same $_.Current.Name 'Claude') })
    if ($documents.Count -eq 0 -and $AllowMissing) { return $null }
    if ($documents.Count -ne 1) { throw 'Active Claude document is missing or ambiguous.' }
    $document = $documents[0]
    $all = $document.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition)
    $messages = @($all | Where-Object {
        $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Group -and
        $_.Current.Name -match '^Message [0-9]+$'
    })
    if ($messages.Count -ne 0) {
        if ($AllowMissing) { return $null }
        throw 'Active view is not a blank new session.'
    }
    $inputs = @($all | Where-Object {
        $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and
        (Same $_.Current.Name 'Prompt')
    })
    if ($inputs.Count -eq 0 -and $AllowMissing) { return $null }
    if ($inputs.Count -ne 1) { throw 'Prompt is missing or ambiguous.' }
    $input = $inputs[0]
    if (-not $input.Current.IsEnabled -or $input.Current.IsOffscreen) { throw 'Prompt is unavailable.' }
    $value = $input.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($value.Current.IsReadOnly) { throw 'Prompt is read-only.' }
    $projectName = Split-Path -Leaf $Config.ProjectDir
    $projectPaths = @($all | Where-Object {
        $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text -and
        (SamePath $_.Current.Name $Config.ProjectDir) -and -not $_.Current.IsOffscreen
    })
    if ($projectPaths.Count -eq 0 -and $AllowMissing) { return $null }
    if ($projectPaths.Count -ne 1) { throw 'Full project path is missing or ambiguous in the blank session.' }
    $environments = @($all | Where-Object {
        $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
        (Same $_.Current.Name ('Environment: ' + $projectName))
    })
    if ($environments.Count -eq 0 -and $AllowMissing) { return $null }
    if ($environments.Count -ne 1) { throw 'Requested project environment is missing or ambiguous.' }
    if (-not $environments[0].Current.IsEnabled) { throw 'Project environment is unavailable.' }
    $prepared = $Config.AllowPrepared -eq $true -and (Same $value.Current.Value $Config.Prompt)
    if (-not (EmptyEditor @{ Value = $value; Input = $input }) -and -not $prepared) {
        throw 'New-session composer is not empty or is not this request draft; existing draft preserved.'
    }
    return @{ Root = $root; Document = $document; Input = $input; Value = $value; Fingerprint = @{
        Pid = [string]$process.Id
        Start = [string]$process.StartTime.Ticks
        Hwnd = [string]$process.MainWindowHandle
        Document = ($document.GetRuntimeId() -join ',')
        DraftBefore = $value.Current.Value
    } }
}

function NewContext($Config) {
    $context = FindNewContext $Config $false
    if ($null -eq $context) { throw 'Active view is not the requested blank new session.' }
    return $context
}

function OpenNewContext($Config) {
    $existing = FindNewContext $Config $true
    if ($null -ne $existing) { return $existing }

    $process = ClaudeWindow
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
    $projectName = Split-Path -Leaf $Config.ProjectDir
    $open = Unique $root ([System.Windows.Automation.ControlType]::Button) ('New session in ' + $projectName)
    if (-not $open.Current.IsEnabled -or $open.Current.IsOffscreen) {
        throw 'Requested project new-session button is unavailable.'
    }
    $open.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()

    $deadline = (Get-Date).AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 100
        $opened = FindNewContext $Config $true
        if ($null -ne $opened) { return $opened }
    } while ((Get-Date) -lt $deadline)
    throw 'Requested project blank new session did not appear after opening.'
}

function HasClassToken($Element, [string]$Token) {
    foreach ($part in [regex]::Split([string]$Element.Current.ClassName, '\s+')) {
        if (Same $part $Token) { return $true }
    }
    return $false
}

function AssistantRows($Element, $Ids, [int]$Depth = 0) {
    if ($Depth -ge 64) { throw 'Assistant tree is too deep to verify safely.' }
    foreach ($child in (RawChildren $Element)) {
        if ($child.Current.ControlType -eq [System.Windows.Automation.ControlType]::Group -and
            (HasClassToken $child 'group/message-row') -and (HasClassToken $child 'flex-col')) {
            $matches = @()
            for ($index = 0; $index -lt $Ids.Count; $index++) {
                if ($child.Current.AutomationId.EndsWith(('_' + $Ids[$index]), [StringComparison]::Ordinal)) {
                    $matches += $index
                }
            }
            if ($matches.Count -gt 1) { throw 'Assistant body row is missing or ambiguous.' }
            if ($matches.Count -eq 1) { @{ Element = $child; Index = $matches[0] } }
        }
        AssistantRows $child $Ids ($Depth + 1)
    }
}

function AddViewText($Tokens, [string]$Text) {
    if ($Text.Length -eq 0) { return }
    if ($Tokens.Count -gt 0 -and (Same $Tokens[$Tokens.Count - 1].type 'text')) {
        $Tokens[$Tokens.Count - 1].text += $Text
    } else {
        [void]$Tokens.Add([pscustomobject]@{ type = 'text'; text = $Text })
    }
}

function ListMarker($Item) {
    $children = @(RawChildren $Item)
    if ($children.Count -eq 0 -or $children[0].Current.ControlType -ne [System.Windows.Automation.ControlType]::Text) {
        throw 'Unsupported assistant content: list marker is unavailable.'
    }
    $marker = $children[0].Current.Name
    if ($marker -cmatch '^([0-9]{1,9})\.\s+$') {
        return @{ Kind = 'ordered'; Ordinal = [int]$Matches[1]; Children = $children }
    }
    if ($marker -cmatch '^[\u2022\u25e6]\s+$') {
        return @{ Kind = 'unordered'; Ordinal = $null; Children = $children }
    }
    throw 'Unsupported assistant content: unknown list marker.'
}

function ProjectAssistantNode($Element, $Tokens, [int]$ListDepth = -1, [int]$Depth = 0) {
    if ($Depth -ge 64) { throw 'Assistant content is too deep to verify safely.' }
    $info = $Element.Current
    # Only an exact renderer class token identifies a non-reply tool status card.
    if ($info.ControlType -eq [System.Windows.Automation.ControlType]::Group -and
        (HasClassToken $Element 'group/status')) { return }
    if ($info.ControlType -eq [System.Windows.Automation.ControlType]::ToolBar -or
        $info.ControlType -eq [System.Windows.Automation.ControlType]::StatusBar) { return }
    if ($info.ControlType -eq [System.Windows.Automation.ControlType]::Text) {
        if ((HasClassToken $Element 'sr-only') -and
            $info.Name.StartsWith('Claude responded: ', [StringComparison]::Ordinal)) { return }
        if ($info.Name.Length -gt 0) { AddViewText $Tokens $info.Name; return }
    } elseif ($info.ControlType -eq [System.Windows.Automation.ControlType]::Button) {
        if (-not (HasClassToken $Element 'prose-link') -or [string]::IsNullOrEmpty($info.Name)) {
            throw 'Unsupported assistant content: unknown button inside reply.'
        }
        # Displayed file references are content, never invoked; do not read duplicated child text.
        AddViewText $Tokens $info.Name
        return
    } elseif ($info.ControlType -eq [System.Windows.Automation.ControlType]::Hyperlink) {
        if ([string]::IsNullOrEmpty($info.Name)) { throw 'Unsupported assistant content: unnamed link.' }
        AddViewText $Tokens $info.Name
        return
    } elseif ($info.ControlType -eq [System.Windows.Automation.ControlType]::Separator) {
        [void]$Tokens.Add([pscustomobject]@{ type = 'rule' })
        return
    } elseif ($info.ControlType -eq [System.Windows.Automation.ControlType]::List) {
        $items = @(RawChildren $Element)
        if ($items.Count -eq 0) { throw 'Unsupported assistant content: empty list.' }
        foreach ($item in $items) {
            if ($item.Current.ControlType -ne [System.Windows.Automation.ControlType]::ListItem) {
                throw 'Unsupported assistant content: unknown list child.'
            }
        }
        $level = $ListDepth + 1
        $kind = (ListMarker $items[0]).Kind
        [void]$Tokens.Add([pscustomobject]@{ type = 'list_start'; kind = $kind; depth = $level })
        foreach ($item in $items) {
            $marker = ListMarker $item
            if (-not (Same $marker.Kind $kind)) { throw 'Unsupported assistant content: mixed list markers.' }
            [void]$Tokens.Add([pscustomobject]@{ type = 'item_start'; depth = $level; ordinal = $marker.Ordinal })
            for ($index = 1; $index -lt $marker.Children.Count; $index++) {
                ProjectAssistantNode $marker.Children[$index] $Tokens $level ($Depth + 1)
            }
            [void]$Tokens.Add([pscustomobject]@{ type = 'item_end'; depth = $level })
        }
        [void]$Tokens.Add([pscustomobject]@{ type = 'list_end'; depth = $level })
        return
    } elseif ($info.ControlType -ne [System.Windows.Automation.ControlType]::Group) {
        throw 'Unsupported assistant content: unknown reply element.'
    }
    # The verified flex-column renderer supplies block boundaries. Other wrappers stay
    # inline: inserting spaces between styled leaves would corrupt file.cs and (-1).
    $column = HasClassToken $Element 'flex-col'
    foreach ($child in (RawChildren $Element)) {
        ProjectAssistantNode $child $Tokens $ListDepth ($Depth + 1)
        if ($column) { AddViewText $Tokens "`n" }
    }
}

function VerifiedAssistantRow($Group, $Config) {
    $ids = @($Config.SourceAssistantMessageIds)
    if ($ids.Count -eq 0) { throw 'Assistant body row is missing or ambiguous.' }
    foreach ($id in $ids) {
        if ($id -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$') { throw 'Assistant body row is missing or ambiguous.' }
    }
    $rows = @(AssistantRows $Group $ids)
    if ($rows.Count -ne 1) { throw 'Assistant body row is missing or ambiguous.' }
    return $rows[0]
}

function SameReplyView($Tokens, $Expected) {
    $actual = @($Tokens | ForEach-Object {
        if (Same $_.type 'text') { $_.text = Normalize $_.text; if ($_.text.Length -gt 0) { $_ } } else { $_ }
    })
    $expectedItems = @($Expected)
    if ($actual.Count -ne $expectedItems.Count) { return $false }
    for ($index = 0; $index -lt $actual.Count; $index++) {
        $item = $actual[$index]
        $expectedItem = $expectedItems[$index]
        if (-not (Same $item.type $expectedItem.type)) { return $false }
        $keys = switch ($item.type) {
            'text' { @('text') }
            'list_start' { @('kind', 'depth') }
            'item_start' { @('depth', 'ordinal') }
            'item_end' { @('depth') }
            'list_end' { @('depth') }
            'rule' { @() }
            default { return $false }
        }
        foreach ($key in $keys) {
            if (-not (Same ([string]$item.$key) ([string]$expectedItem.$key))) { return $false }
        }
    }
    return $true
}

function ExistingDocument($Root, $Config) {
    # Document.Name includes a product suffix; the authoritative title is in Session tools.
    # Never accept the sidebar's same-name buttons as proof of the active conversation.
    $documents = $Root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        (New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'RootWebArea')))
    $active = @()
    foreach ($document in $documents) {
        if ($document.Current.ControlType -ne [System.Windows.Automation.ControlType]::Document -or
            $document.Current.IsOffscreen) { continue }
        $tools = $document.FindAll([System.Windows.Automation.TreeScope]::Descendants,
            (Condition ([System.Windows.Automation.ControlType]::ToolBar) 'Session tools'))
        $tools = @($tools | Where-Object { -not $_.Current.IsOffscreen })
        if ($tools.Count -gt 1) { throw 'Active Claude document is missing or ambiguous.' }
        if ($tools.Count -eq 1) { $active += @{ Document = $document; Tools = $tools[0] } }
    }
    if ($active.Count -ne 1) { throw 'Active Claude document is missing or ambiguous.' }
    $titles = $active[0].Tools.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        (Condition ([System.Windows.Automation.ControlType]::Text) $Config.Title))
    $titles = @($titles | Where-Object { -not $_.Current.IsOffscreen })
    if ($titles.Count -ne 1) { throw 'Missing or ambiguous active session title in Session tools.' }
    return $active[0].Document
}

function ExistingComposer($Primary, $Editor, $Value, $Details, $Messages) {
    # Chromium omits form wrappers from ControlView. Walk RawView to include the entire
    # composer, but stop before its ancestor also contains session details or chat history.
    $primaryId = $Primary.GetRuntimeId() -join ','
    $ancestor = RawParent $Editor
    $candidate = $null
    $emptyCandidate = $null
    $previous = $Editor
    for ($depth = 0; $depth -lt 64 -and $null -ne $ancestor; $depth++) {
        $items = @($ancestor.FindAll([System.Windows.Automation.TreeScope]::Descendants,
            [System.Windows.Automation.Condition]::TrueCondition))
        $outside = @($items | Where-Object {
            $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Group -and
            $_.Current.Name -in @('Session details', 'Chat messages')
        })
        if ($outside.Count -gt 0) {
            if ($null -eq $candidate) {
                # An empty dock needs both already-verified identities at the later boundary.
                if ($null -ne $emptyCandidate -and $outside.Count -eq 2 -and
                    @($outside | Where-Object { Same ($_.GetRuntimeId() -join ',') ($Details.GetRuntimeId() -join ',') }).Count -eq 1 -and
                    @($outside | Where-Object { Same ($_.GetRuntimeId() -join ',') ($Messages.GetRuntimeId() -join ',') }).Count -eq 1 -and
                    (EmptyEditor @{ Value = $Value; Input = $Editor }) -eq $true) {
                    # Prune only verified roots; history attachments are not composer evidence.
                    $scopedIds = New-Object 'System.Collections.Generic.HashSet[string]'
                    foreach ($subtree in @($emptyCandidate, $Details, $Messages)) {
                        [void]$scopedIds.Add(($subtree.GetRuntimeId() -join ','))
                    }
                    $primaryQueryIds = New-Object 'System.Collections.Generic.HashSet[string]'
                    foreach ($item in $Primary.FindAll([System.Windows.Automation.TreeScope]::Descendants,
                        [System.Windows.Automation.Condition]::TrueCondition)) {
                        [void]$primaryQueryIds.Add(($item.GetRuntimeId() -join ','))
                    }
                    $pending = New-Object 'System.Collections.Generic.Queue[object]'
                    $pending.Enqueue(@{ Element = $Primary; Depth = 0 })
                    $visited = 0
                    while ($pending.Count -gt 0) {
                        $node = $pending.Dequeue()
                        if ($node.Depth -ge 64) { throw 'Cannot isolate the current composer safely.' }
                        foreach ($child in (RawChildren $node.Element)) {
                            $visited++
                            if ($visited -gt 4096) { throw 'Cannot isolate the current composer safely.' }
                            $id = $child.GetRuntimeId() -join ','
                            if ($scopedIds.Contains($id)) { continue }
                            if ($child.Current.ControlType -in @([System.Windows.Automation.ControlType]::Button,
                                [System.Windows.Automation.ControlType]::Image, [System.Windows.Automation.ControlType]::Hyperlink,
                                [System.Windows.Automation.ControlType]::ListItem) -and -not $primaryQueryIds.Contains($id)) {
                                throw 'Unscoped attachment, preview or action outside the verified composer; nothing was changed.'
                            }
                            $pending.Enqueue(@{ Element = $child; Depth = $node.Depth + 1 })
                        }
                    }
                    return $emptyCandidate
                }
                break
            }
            return $candidate
        }
        if (Same ($ancestor.GetRuntimeId() -join ',') $primaryId) { break }
        $edits = @($items | Where-Object {
            $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and (Same $_.Current.Name 'Prompt')
        })
        $sends = @($items | Where-Object {
            $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and (Same $_.Current.Name 'Send')
        })
        $adds = @($items | Where-Object {
            $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and (Same $_.Current.Name 'Add')
        })
        if ($edits.Count -gt 1 -or $sends.Count -gt 1 -or $adds.Count -gt 1) { break }
        if ($edits.Count -eq 1 -and $sends.Count -eq 1 -and $adds.Count -eq 1) { $candidate = $ancestor }
        if ($null -eq $candidate -and $null -eq $emptyCandidate -and
            $null -ne $Value -and $null -ne $Details -and $null -ne $Messages -and
            $edits.Count -eq 1 -and $sends.Count -eq 0 -and $adds.Count -eq 1 -and
            $ancestor.Current.ControlType -eq [System.Windows.Automation.ControlType]::Group -and
            (HasClassToken $ancestor 'group/approval-dock') -and
            $previous.Current.ControlType -eq [System.Windows.Automation.ControlType]::Group -and
            (HasClassToken $previous 'rounded-composer') -and
            (EmptyEditor @{ Value = $Value; Input = $Editor }) -eq $true) {
            # Only the exact renderer shell's direct Raw parent can be an empty dock.
            # Bound Raw evidence also catches hidden actions and query-omitted duplicates.
            $rawItems = New-Object 'System.Collections.Generic.List[object]'
            [void]$rawItems.Add($ancestor)
            $pending = New-Object 'System.Collections.Generic.Queue[object]'
            $pending.Enqueue(@{ Element = $ancestor; Depth = 0 })
            while ($pending.Count -gt 0) {
                $node = $pending.Dequeue()
                if ($node.Depth -ge 64) { throw 'Cannot isolate the current composer safely.' }
                foreach ($child in (RawChildren $node.Element)) {
                    if ($rawItems.Count -ge 4096) { throw 'Cannot isolate the current composer safely.' }
                    [void]$rawItems.Add($child)
                    $pending.Enqueue(@{ Element = $child; Depth = $node.Depth + 1 })
                }
            }
            $rawEdits = @($rawItems | Where-Object {
                $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and (Same $_.Current.Name 'Prompt')
            })
            $rawAdds = @($rawItems | Where-Object {
                $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and (Same $_.Current.Name 'Add')
            })
            $rawSendOrStop = @($rawItems | Where-Object { (Same $_.Current.Name 'Send') -or (Same $_.Current.Name 'Stop') })
            if ($rawEdits.Count -ne 1 -or $rawAdds.Count -ne 1 -or $rawSendOrStop.Count -ne 0 -or
                -not (Same ($rawEdits[0].GetRuntimeId() -join ',') ($Editor.GetRuntimeId() -join ','))) { break }
            $queryIds = New-Object 'System.Collections.Generic.HashSet[string]'
            foreach ($item in $items) { [void]$queryIds.Add(($item.GetRuntimeId() -join ',')) }
            foreach ($item in $rawItems) {
                if ($item.Current.ControlType -in @([System.Windows.Automation.ControlType]::Button,
                    [System.Windows.Automation.ControlType]::Image, [System.Windows.Automation.ControlType]::Hyperlink,
                    [System.Windows.Automation.ControlType]::ListItem) -and
                    -not $queryIds.Contains(($item.GetRuntimeId() -join ','))) {
                    throw 'Cannot isolate the current composer safely.'
                }
            }
            # Queryable attachments and unknown actions still go through the original guards.
            $emptyCandidate = $ancestor
        }
        $previous = $ancestor
        $ancestor = RawParent $ancestor
    }
    throw 'Cannot isolate the current composer safely.'
}

function AssertNoUnscopedAttachments($Primary, $Composer, $Details, $Messages) {
    # A preview can be a sibling of the form. Exclude only the three proven subtrees,
    # then reject attachment-like content or unknown actions elsewhere in the chat pane.
    $known = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($subtree in @($Composer, $Details, $Messages)) {
        [void]$known.Add(($subtree.GetRuntimeId() -join ','))
        foreach ($item in $subtree.FindAll([System.Windows.Automation.TreeScope]::Descendants,
            [System.Windows.Automation.Condition]::TrueCondition)) {
            [void]$known.Add(($item.GetRuntimeId() -join ','))
        }
    }
    foreach ($item in $Primary.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition)) {
        if ($known.Contains(($item.GetRuntimeId() -join ','))) { continue }
        $type = $item.Current.ControlType
        if ($type -eq [System.Windows.Automation.ControlType]::Image -or
            $type -eq [System.Windows.Automation.ControlType]::Hyperlink -or
            $type -eq [System.Windows.Automation.ControlType]::ListItem -or
            $type -eq [System.Windows.Automation.ControlType]::Button) {
            throw 'Unscoped attachment, preview or action outside the verified composer; nothing was changed.'
        }
    }
}

function Context($Config) {
    $process = ClaudeWindow
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
    $document = ExistingDocument $root $Config
    $primary = Unique $document ([System.Windows.Automation.ControlType]::Group) 'Primary pane'
    if ($primary.Current.IsOffscreen) { throw 'Expected chat pane is not visible.' }
    $messages = Unique $primary ([System.Windows.Automation.ControlType]::Group) 'Chat messages'
    $all = $messages.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition)
    $groups = @($all | Where-Object {
        $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Group -and
        $_.Current.Name -match '^Message [0-9]+$'
    })
    $lastUser = $null
    $lastUserGroup = $null
    $assistantGroups = @()
    foreach ($group in $groups) {
        $textCondition = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Text)
        $first = $group.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $textCondition)
        if ($null -eq $first) { continue }
        $label = $first.Current.Name
        if ($label.StartsWith('You said: ', [StringComparison]::Ordinal)) {
            $lastUser = $label.Substring('You said: '.Length)
            $lastUserGroup = $group
            $assistantGroups = @()
        } elseif ($label.StartsWith('Claude responded: ', [StringComparison]::Ordinal)) {
            if ($null -ne $lastUser) { $assistantGroups += $group }
        }
    }
    if ($null -eq $lastUserGroup) { throw 'Latest human turn does not match the specified original session.' }
    $lastUser = VerifiedHumanBody $lastUserGroup $Config
    if (-not (Same $lastUser $Config.LastUserRendered)) {
        throw 'Latest human turn does not match the specified original session.'
    }
    $replyTokens = New-Object 'System.Collections.Generic.List[object]'
    $previousRowIndex = -1
    foreach ($group in $assistantGroups) {
        $row = VerifiedAssistantRow $group $Config
        if ($row.Index -le $previousRowIndex) { throw 'Assistant body row is missing or ambiguous; reply order changed.' }
        $previousRowIndex = $row.Index
        ProjectAssistantNode $row.Element $replyTokens
        AddViewText $replyTokens "`n"
    }
    if ($assistantGroups.Count -eq 0 -or -not (SameReplyView $replyTokens $Config.SourceReplyView)) {
        throw 'Latest complete assistant body does not match the source log view; UI-only content was not discarded.'
    }
    $input = Unique $primary ([System.Windows.Automation.ControlType]::Edit) 'Prompt'
    if (-not $input.Current.IsEnabled -or $input.Current.IsOffscreen) { throw 'Prompt is unavailable.' }
    $value = $input.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($value.Current.IsReadOnly) { throw 'Prompt is read-only.' }
    $details = Unique $primary ([System.Windows.Automation.ControlType]::Group) 'Session details'
    $environment = Unique $details ([System.Windows.Automation.ControlType]::Group) 'Environment'
    if ([string]::IsNullOrWhiteSpace($Config.SourceCwd)) { throw 'Source session has no full project path; identity cannot be verified.' }
    $sourcePath = [IO.Path]::GetFullPath($Config.SourceCwd).TrimEnd([char[]]@('\', '/'))
    $environmentName = (Split-Path -Leaf $sourcePath) + ' ' + (Split-Path -Parent $sourcePath)
    $environmentItems = $environment.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition)
    $paths = @($environmentItems | Where-Object {
        -not $_.Current.IsOffscreen -and (
            ($_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text -and (SamePath $_.Current.Name $sourcePath)) -or
            ($_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
                [string]::Equals($_.Current.Name, $environmentName, [StringComparison]::OrdinalIgnoreCase)))
    })
    if ($paths.Count -ne 1) { throw 'Full project path is missing or ambiguous in the active session environment.' }
    $composer = ExistingComposer $primary $input $value $details $messages
    AssertNoUnscopedAttachments $primary $composer $details $messages
    $composerItems = $composer.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($item in $composerItems) {
        $info = $item.Current
        if ($info.ControlType -eq [System.Windows.Automation.ControlType]::Image -or
            $info.ControlType -eq [System.Windows.Automation.ControlType]::Hyperlink -or
            $info.ControlType -eq [System.Windows.Automation.ControlType]::ListItem) {
            throw 'Composer contains attachment or preview content; it was preserved.'
        }
        if ($info.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
            $info.Name -notmatch '^(Add|Send|Stop|Bypass permissions|Model: .+|Usage: .+|Environment|Reorder Environment|Edit environment|Context [0-9]+%|Reorder Context)$' -and
            -not (Same $info.Name $environmentName)) {
            throw ('Composer has an unrecognized action or attachment: ' + $info.Name + '; nothing was changed.')
        }
    }
    return @{ Document = $document; Composer = $composer; Input = $input; Value = $value; Fingerprint = @{
        Pid = [string]$process.Id
        Start = [string]$process.StartTime.Ticks
        Hwnd = [string]$process.MainWindowHandle
        Document = ($document.GetRuntimeId() -join ',')
        DraftBefore = $value.Current.Value
    } }
}

try {
    $config = [IO.File]::ReadAllText($ConfigPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($Action -eq 'NewPrepare') { $config.AllowPrepared = $true }
    $isNew = $Action.StartsWith('New', [StringComparison]::Ordinal)
    $context = if ($Action -eq 'NewOpen') {
        OpenNewContext $config
    } elseif ($isNew) {
        NewContext $config
    } else {
        Context $config
    }
    if ($Action -notin @('Inspect', 'NewOpen', 'NewInspect')) {
        foreach ($key in @('Pid', 'Start', 'Hwnd', 'Document')) {
            if (-not (Same $context.Fingerprint[$key] ([string]$config.Fingerprint.$key))) {
                throw 'Window or chat changed after preparation; nothing was sent.'
            }
        }
    }
    if ($Action -in @('Send', 'NewSend')) {
        if (-not (Same $context.Value.Current.Value $config.Prompt)) {
            throw 'Draft changed after preparation; nothing was sent.'
        }
        $sendRoot = if ($isNew) { $context.Document } else { $context.Composer }
        $send = Unique $sendRoot ([System.Windows.Automation.ControlType]::Button) 'Send'
        if (-not $send.Current.IsEnabled -or $send.Current.IsOffscreen) {
            throw 'Send button is unavailable; nothing was sent.'
        }
        $send.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    } else {
        $ownDraft = $Action -in @('Prepare', 'NewPrepare') -and
            (Same $context.Value.Current.Value $config.Prompt)
        if (-not (EmptyEditor $context) -and -not $ownDraft) {
            throw 'Existing draft preserved; refusing to overwrite it.'
        }
        if ($Action -in @('Prepare', 'NewPrepare')) {
            if (-not $ownDraft) { $context.Value.SetValue($config.Prompt) }
            $deadline = (Get-Date).AddSeconds(5)
            do {
                if (Same $context.Value.Current.Value $config.Prompt) { break }
                Start-Sleep -Milliseconds 100
            } while ((Get-Date) -lt $deadline)
            if (-not (Same $context.Value.Current.Value $config.Prompt)) {
                throw 'Prompt could not be verified; nothing was sent.'
            }
        }
    }
    [Console]::Write(($context.Fingerprint | ConvertTo-Json -Compress))
    exit 0
} catch {
    [Console]::Error.WriteLine('dsh-au-client-control-uia: ' + $_.Exception.Message)
    exit 1
}
