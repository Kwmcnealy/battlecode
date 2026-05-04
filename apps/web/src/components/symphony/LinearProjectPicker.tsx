import type { SymphonyLinearProject } from "@t3tools/contracts";

export interface LinearProjectPickerProps {
  readonly projects: readonly SymphonyLinearProject[];
  readonly onSelect: (project: SymphonyLinearProject) => void;
}

export function LinearProjectPicker(props: LinearProjectPickerProps) {
  const grouped = new Map<string, SymphonyLinearProject[]>();
  for (const project of props.projects) {
    const list = grouped.get(project.teamName) ?? [];
    list.push(project);
    grouped.set(project.teamName, list);
  }

  return (
    <div>
      <label htmlFor="symphony-project">Linear project</label>
      <select
        id="symphony-project"
        disabled={props.projects.length === 0}
        onChange={(e) => {
          const project = props.projects.find((p) => p.id === e.target.value);
          if (project) props.onSelect(project);
        }}
        defaultValue=""
      >
        <option value="" disabled>
          Choose a project
        </option>
        {[...grouped.entries()].map(([teamName, list]) => (
          <optgroup key={teamName} label={teamName}>
            {list.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}
