# Obsidian Canvas Format Reference

Obsidian Canvas files (`.canvas`) are JSON files that define a spatial layout of nodes and edges.

## Node Types

### Text Node
```json
{
  "id": "unique-id",
  "type": "text",
  "text": "# Markdown Content\nSupports **bold**, [links](...), and $LaTeX$",
  "x": 0,
  "y": 0,
  "width": 400,
  "height": 300,
  "color": "1"
}
```

### File Node
```json
{
  "id": "unique-id",
  "type": "file",
  "file": "path/to/note.md",
  "x": 500,
  "y": 0,
  "width": 400,
  "height": 300
}
```

### Link Node
```json
{
  "id": "unique-id",
  "type": "link",
  "url": "https://example.com",
  "x": 1000,
  "y": 0,
  "width": 400,
  "height": 300
}
```

## Colors
- `"1"`: Red
- `"2"`: Orange
- `"3"`: Yellow
- `"4"`: Green
- `"5"`: Blue
- `"6"`: Purple

## Edges
```json
{
  "id": "edge-id",
  "fromNode": "node-1",
  "fromSide": "right",
  "toNode": "node-2",
  "toSide": "left",
  "label": "relationship",
  "color": "4"
}
```
Sides: `"top"`, `"right"`, `"bottom"`, `"left"`
