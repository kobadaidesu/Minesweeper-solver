use rand::prelude::*;
use std::collections::{HashSet, VecDeque};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cell {
    pub has_mine: bool,
    pub is_revealed: bool,
    pub is_flagged: bool,
    pub neighbor_mines: u8,
    pub index: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GameState {
    Ready,
    Playing,
    Won,
    Lost,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuleType {
    Info,
    Rule1,
    Rule2,
    Rule3,
    Rule4,
}

impl RuleType {
    pub fn label(self) -> &'static str {
        match self {
            Self::Info => "INFO",
            Self::Rule1 => "RULE 1",
            Self::Rule2 => "RULE 2",
            Self::Rule3 => "RULE 3",
            Self::Rule4 => "RULE 4",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogEntry {
    pub message: String,
    pub rule_type: RuleType,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StepType {
    Reveal,
    Flag,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SolverStep {
    pub step_type: StepType,
    pub cells: Vec<usize>,
    pub log: LogEntry,
}

#[derive(Clone, Debug)]
struct NeighborInfo {
    flagged: Vec<usize>,
    unrevealed: Vec<usize>,
}

#[derive(Clone, Debug)]
pub struct Minesweeper {
    pub width: usize,
    pub height: usize,
    pub total_mines: usize,
    pub cells: Vec<Cell>,
    pub game_state: GameState,
    pub first_click: bool,
    pub clear_count: usize,
    pub animation_speed_ms: f32,
    pub reasoning_log: Vec<LogEntry>,
    pub dirty_set: HashSet<usize>,
    neighbors_cache: Vec<Vec<usize>>,
    extended_neighbors_cache: Vec<Vec<usize>>,
}

impl Minesweeper {
    pub const MIN_SIZE: usize = 5;
    pub const MAX_SIZE: usize = 100;
    pub const DEFAULT_SPEED_MS: f32 = 10.0;

    pub fn sanitize_settings(width: usize, height: usize, mines: usize) -> (usize, usize, usize) {
        let width = width.clamp(Self::MIN_SIZE, Self::MAX_SIZE);
        let height = height.clamp(Self::MIN_SIZE, Self::MAX_SIZE);
        let max_mines = width * height - 1;
        let mines = mines.clamp(1, max_mines);
        (width, height, mines)
    }

    pub fn new(width: usize, height: usize, mine_count: usize) -> Self {
        let (width, height, mine_count) = Self::sanitize_settings(width, height, mine_count);
        let mut game = Self {
            width,
            height,
            total_mines: mine_count,
            cells: Vec::new(),
            game_state: GameState::Ready,
            first_click: true,
            clear_count: 0,
            animation_speed_ms: Self::DEFAULT_SPEED_MS,
            reasoning_log: Vec::new(),
            dirty_set: HashSet::new(),
            neighbors_cache: Vec::new(),
            extended_neighbors_cache: Vec::new(),
        };
        game.init_game();
        game
    }

    fn init_game(&mut self) {
        self.cells.clear();
        self.reasoning_log.clear();
        self.clear_count = 0;
        self.neighbors_cache = vec![Vec::new(); self.width * self.height];
        self.extended_neighbors_cache = vec![Vec::new(); self.width * self.height];
        self.dirty_set.clear();

        for i in 0..self.width * self.height {
            self.cells.push(Cell {
                has_mine: false,
                is_revealed: false,
                is_flagged: false,
                neighbor_mines: 0,
                index: i,
            });
            self.neighbors_cache[i] = self.calculate_neighbors(i);
            self.dirty_set.insert(i);
        }

        self.precompute_extended_neighbors();
    }

    fn calculate_neighbors(&self, index: usize) -> Vec<usize> {
        let mut neighbors = Vec::with_capacity(8);
        let x = index % self.width;
        let y = index / self.width;

        for dy in -1..=1 {
            for dx in -1..=1 {
                if dx == 0 && dy == 0 {
                    continue;
                }

                let nx = x as isize + dx;
                let ny = y as isize + dy;
                if nx >= 0 && nx < self.width as isize && ny >= 0 && ny < self.height as isize {
                    neighbors.push(ny as usize * self.width + nx as usize);
                }
            }
        }

        neighbors
    }

    fn precompute_extended_neighbors(&mut self) {
        for i in 0..self.cells.len() {
            let mut extended = HashSet::new();
            for &neighbor in &self.neighbors_cache[i] {
                extended.insert(neighbor);
                for &second_neighbor in &self.neighbors_cache[neighbor] {
                    extended.insert(second_neighbor);
                }
            }
            extended.remove(&i);
            self.extended_neighbors_cache[i] = extended.into_iter().collect();
        }
    }

    #[cfg(test)]
    pub fn neighbors(&self, index: usize) -> &[usize] {
        &self.neighbors_cache[index]
    }

    pub fn index_to_coords(&self, index: usize) -> String {
        format!("({},{})", index % self.width, index / self.width)
    }

    pub fn add_log(&mut self, message: impl Into<String>, rule_type: RuleType) {
        self.reasoning_log.push(LogEntry {
            message: message.into(),
            rule_type,
        });
        if self.reasoning_log.len() > 200 {
            let overflow = self.reasoning_log.len() - 200;
            self.reasoning_log.drain(0..overflow);
        }
    }

    pub fn place_mines(&mut self, exclude_index: usize) {
        let mut rng = rand::rng();
        self.place_mines_with_rng(exclude_index, &mut rng);
    }

    fn place_mines_with_rng<R: Rng + ?Sized>(&mut self, exclude_index: usize, rng: &mut R) {
        let mut available: Vec<usize> = (0..self.cells.len())
            .filter(|&index| index != exclude_index)
            .collect();
        available.shuffle(rng);

        for &index in available.iter().take(self.total_mines) {
            self.cells[index].has_mine = true;
        }

        self.calculate_neighbor_mines();
    }

    fn calculate_neighbor_mines(&mut self) {
        for i in 0..self.cells.len() {
            if !self.cells[i].has_mine {
                self.cells[i].neighbor_mines = self.count_neighbor_mines(i);
            }
        }
    }

    fn count_neighbor_mines(&self, index: usize) -> u8 {
        self.neighbors_cache[index]
            .iter()
            .filter(|&&neighbor| self.cells[neighbor].has_mine)
            .count() as u8
    }

    pub fn reveal_cell(&mut self, index: usize) -> bool {
        if matches!(self.game_state, GameState::Won | GameState::Lost) || index >= self.cells.len()
        {
            return false;
        }
        if self.cells[index].is_revealed || self.cells[index].is_flagged {
            return false;
        }

        if self.first_click {
            self.place_mines(index);
            self.first_click = false;
            self.game_state = GameState::Playing;
        }

        self.reveal_cell_without_first_click(index)
    }

    fn reveal_cell_without_first_click(&mut self, index: usize) -> bool {
        if index >= self.cells.len()
            || self.cells[index].is_revealed
            || self.cells[index].is_flagged
        {
            return false;
        }

        self.cells[index].is_revealed = true;
        self.clear_count += 1;
        self.dirty_set.insert(index);

        if self.cells[index].has_mine {
            self.game_state = GameState::Lost;
            self.add_log("地雷を踏んでしまいました...", RuleType::Info);
            self.reveal_all_mines();
            return false;
        }

        if self.cells[index].neighbor_mines == 0 {
            self.reveal_zero_area(index);
        }

        true
    }

    fn reveal_zero_area(&mut self, index: usize) {
        let mut queue = VecDeque::new();
        let mut processed = HashSet::new();
        queue.push_back(index);
        processed.insert(index);

        while let Some(current) = queue.pop_front() {
            let neighbors = self.neighbors_cache[current].clone();
            for neighbor_index in neighbors {
                if processed.contains(&neighbor_index) {
                    continue;
                }

                let neighbor = &self.cells[neighbor_index];
                if neighbor.is_revealed || neighbor.is_flagged || neighbor.has_mine {
                    continue;
                }

                self.cells[neighbor_index].is_revealed = true;
                self.clear_count += 1;
                self.dirty_set.insert(neighbor_index);
                processed.insert(neighbor_index);

                if self.cells[neighbor_index].neighbor_mines == 0 {
                    queue.push_back(neighbor_index);
                }
            }
        }
    }

    pub fn flag_cell(&mut self, index: usize) {
        if self.game_state != GameState::Playing || index >= self.cells.len() {
            return;
        }
        if self.cells[index].is_revealed {
            return;
        }

        self.cells[index].is_flagged = !self.cells[index].is_flagged;
        self.dirty_set.insert(index);
    }

    pub fn get_remaining_mines(&self) -> usize {
        let flagged = self.cells.iter().filter(|cell| cell.is_flagged).count();
        self.total_mines.saturating_sub(flagged)
    }

    pub fn progress(&self) -> f32 {
        let non_mine_cells = self.width * self.height - self.total_mines;
        if non_mine_cells == 0 {
            return 0.0;
        }
        self.clear_count as f32 / non_mine_cells as f32
    }

    pub fn check_win(&mut self) -> bool {
        let all_non_mines_revealed = self
            .cells
            .iter()
            .all(|cell| cell.has_mine || cell.is_revealed);

        if all_non_mines_revealed && self.game_state == GameState::Playing {
            self.game_state = GameState::Won;
            self.add_log("クリア！おめでとうございます！", RuleType::Info);
            for cell in &mut self.cells {
                if cell.has_mine && !cell.is_flagged {
                    cell.is_flagged = true;
                    self.dirty_set.insert(cell.index);
                }
            }
            return true;
        }

        false
    }

    fn reveal_all_mines(&mut self) {
        for cell in &mut self.cells {
            if cell.has_mine && !cell.is_revealed {
                cell.is_revealed = true;
                self.dirty_set.insert(cell.index);
            }
        }
    }

    fn neighbor_info(&self, index: usize) -> NeighborInfo {
        let mut flagged = Vec::new();
        let mut unrevealed = Vec::new();

        for &neighbor_index in &self.neighbors_cache[index] {
            let neighbor = &self.cells[neighbor_index];
            if neighbor.is_flagged {
                flagged.push(neighbor_index);
            } else if !neighbor.is_revealed {
                unrevealed.push(neighbor_index);
            }
        }

        NeighborInfo {
            flagged,
            unrevealed,
        }
    }

    pub fn apply_solving_rules(&mut self) -> Vec<SolverStep> {
        let mut changed = true;
        let mut iterations = 0;
        let max_iterations = 1000;
        let mut steps = Vec::new();

        while changed && iterations < max_iterations {
            changed = false;
            iterations += 1;

            for i in 0..self.cells.len() {
                if !self.cells[i].is_revealed || self.cells[i].neighbor_mines == 0 {
                    continue;
                }

                let info = self.neighbor_info(i);

                if let Some(step) = self.apply_rule1(i, &info) {
                    self.add_log(step.log.message.clone(), step.log.rule_type);
                    steps.push(step);
                    changed = true;
                }

                if let Some(step) = self.apply_rule2(i, &info) {
                    self.add_log(step.log.message.clone(), step.log.rule_type);
                    steps.push(step);
                    changed = true;
                }

                if changed {
                    continue;
                }

                let extended_neighbors = self.extended_neighbors_cache[i].clone();
                for j in extended_neighbors {
                    if !self.cells[j].is_revealed || self.cells[j].neighbor_mines == 0 {
                        continue;
                    }

                    if let Some(step) = self.apply_advanced_rules(i, j) {
                        self.add_log(step.log.message.clone(), step.log.rule_type);
                        steps.push(step);
                        changed = true;
                        break;
                    }
                }
            }
        }

        if let Some(step) = self.apply_final_rule() {
            self.add_log(step.log.message.clone(), step.log.rule_type);
            steps.push(step);
        }

        steps
    }

    pub fn collect_solving_steps(&self) -> Vec<SolverStep> {
        let mut clone = self.clone();
        clone.apply_solving_rules()
    }

    pub fn apply_solver_step(&mut self, step: &SolverStep) -> usize {
        let mut changed_count = 0;
        match step.step_type {
            StepType::Reveal => {
                for &index in &step.cells {
                    let was_revealed = self.cells[index].is_revealed;
                    if self.reveal_cell_without_first_click(index) && !was_revealed {
                        changed_count += 1;
                    }
                }
            }
            StepType::Flag => {
                for &index in &step.cells {
                    if !self.cells[index].is_flagged {
                        self.cells[index].is_flagged = true;
                        self.dirty_set.insert(index);
                        changed_count += 1;
                    }
                }
            }
        }
        self.add_log(step.log.message.clone(), step.log.rule_type);
        changed_count
    }

    fn apply_rule1(&mut self, index: usize, info: &NeighborInfo) -> Option<SolverStep> {
        let cell = &self.cells[index];
        if cell.neighbor_mines as usize != info.flagged.len() || info.unrevealed.is_empty() {
            return None;
        }

        let mut revealed = Vec::new();
        for &neighbor_index in &info.unrevealed {
            if self.reveal_cell_without_first_click(neighbor_index) {
                revealed.push(neighbor_index);
            }
        }

        if revealed.is_empty() {
            return None;
        }

        let coords = self.index_to_coords(index);
        let target_coords = revealed
            .iter()
            .map(|&n| self.index_to_coords(n))
            .collect::<Vec<_>>()
            .join(", ");

        Some(SolverStep {
            step_type: StepType::Reveal,
            cells: revealed,
            log: LogEntry {
                message: format!("Rule 1: {coords} の周りの安全なセルを開く: {target_coords}"),
                rule_type: RuleType::Rule1,
            },
        })
    }

    fn apply_rule2(&mut self, index: usize, info: &NeighborInfo) -> Option<SolverStep> {
        let cell = &self.cells[index];
        if cell.neighbor_mines as usize != info.flagged.len() + info.unrevealed.len()
            || info.unrevealed.is_empty()
        {
            return None;
        }

        let mut flagged = Vec::new();
        for &neighbor_index in &info.unrevealed {
            if !self.cells[neighbor_index].is_flagged {
                self.cells[neighbor_index].is_flagged = true;
                self.dirty_set.insert(neighbor_index);
                flagged.push(neighbor_index);
            }
        }

        if flagged.is_empty() {
            return None;
        }

        let coords = self.index_to_coords(index);
        let target_coords = flagged
            .iter()
            .map(|&n| self.index_to_coords(n))
            .collect::<Vec<_>>()
            .join(", ");

        Some(SolverStep {
            step_type: StepType::Flag,
            cells: flagged,
            log: LogEntry {
                message: format!("Rule 2: {coords} の周りに地雷を配置: {target_coords}"),
                rule_type: RuleType::Rule2,
            },
        })
    }

    fn apply_advanced_rules(&mut self, index_a: usize, index_b: usize) -> Option<SolverStep> {
        let cell_a = &self.cells[index_a];
        let cell_b = &self.cells[index_b];

        let neighbors_a = &self.neighbors_cache[index_a];
        let neighbors_b = &self.neighbors_cache[index_b];
        let neighbors_b_set: HashSet<_> = neighbors_b.iter().copied().collect();

        let mut flagged_a = Vec::new();
        let mut unique_to_a = Vec::new();

        for &neighbor_index in neighbors_a {
            let neighbor = &self.cells[neighbor_index];
            if neighbor.is_flagged {
                flagged_a.push(neighbor_index);
            } else if !neighbor.is_revealed && !neighbors_b_set.contains(&neighbor_index) {
                unique_to_a.push(neighbor_index);
            }
        }

        let neighbors_a_set: HashSet<_> = neighbors_a.iter().copied().collect();
        let mut flagged_b_count = 0;
        let mut unique_to_b = Vec::new();

        for &neighbor_index in neighbors_b {
            let neighbor = &self.cells[neighbor_index];
            if neighbor.is_flagged {
                flagged_b_count += 1;
            } else if !neighbor.is_revealed && !neighbors_a_set.contains(&neighbor_index) {
                unique_to_b.push(neighbor_index);
            }
        }

        if unique_to_a.is_empty() && unique_to_b.is_empty() {
            return None;
        }

        let remaining_a = cell_a.neighbor_mines as isize - flagged_a.len() as isize;
        let remaining_b = cell_b.neighbor_mines as isize - flagged_b_count as isize;

        if !unique_to_a.is_empty() && remaining_a == remaining_b - unique_to_b.len() as isize {
            let targets = unique_to_a.clone();
            for &target in &targets {
                self.reveal_cell_without_first_click(target);
            }
            return Some(self.advanced_step(
                StepType::Reveal,
                targets,
                index_a,
                index_b,
                RuleType::Rule3,
            ));
        }

        if !unique_to_a.is_empty() && remaining_b == remaining_a - unique_to_a.len() as isize {
            let targets = unique_to_a.clone();
            for &target in &targets {
                self.cells[target].is_flagged = true;
                self.dirty_set.insert(target);
            }
            return Some(self.advanced_step(
                StepType::Flag,
                targets,
                index_a,
                index_b,
                RuleType::Rule4,
            ));
        }

        None
    }

    fn advanced_step(
        &self,
        step_type: StepType,
        cells: Vec<usize>,
        index_a: usize,
        index_b: usize,
        rule_type: RuleType,
    ) -> SolverStep {
        let coords_a = self.index_to_coords(index_a);
        let coords_b = self.index_to_coords(index_b);
        let target_coords = cells
            .iter()
            .map(|&n| self.index_to_coords(n))
            .collect::<Vec<_>>()
            .join(", ");
        let action = match step_type {
            StepType::Reveal => "安全なセルを推論",
            StepType::Flag => "地雷を推論",
        };
        let rule_name = match rule_type {
            RuleType::Rule3 => "Rule 3",
            RuleType::Rule4 => "Rule 4",
            _ => "Rule",
        };

        SolverStep {
            step_type,
            cells,
            log: LogEntry {
                message: format!(
                    "{rule_name}: {coords_a} と {coords_b} の関係から{action}: {target_coords}"
                ),
                rule_type,
            },
        }
    }

    fn apply_final_rule(&mut self) -> Option<SolverStep> {
        let mut unrevealed = Vec::new();
        let mut flagged_count = 0;

        for cell in &self.cells {
            if cell.is_flagged {
                flagged_count += 1;
            } else if !cell.is_revealed {
                unrevealed.push(cell.index);
            }
        }

        let remaining_mines = self.total_mines.saturating_sub(flagged_count);
        if unrevealed.len() != remaining_mines || remaining_mines == 0 {
            return None;
        }

        for &index in &unrevealed {
            self.cells[index].is_flagged = true;
            self.dirty_set.insert(index);
        }

        let target_coords = unrevealed
            .iter()
            .map(|&n| self.index_to_coords(n))
            .collect::<Vec<_>>()
            .join(", ");

        Some(SolverStep {
            step_type: StepType::Flag,
            cells: unrevealed,
            log: LogEntry {
                message: format!("最終ルール: 残りの未探索セル全てに地雷を配置: {target_coords}"),
                rule_type: RuleType::Rule4,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prepared_game(width: usize, height: usize, mines: &[usize]) -> Minesweeper {
        let mut game = Minesweeper::new(width, height, mines.len().max(1));
        game.total_mines = mines.len();
        for cell in &mut game.cells {
            cell.has_mine = false;
            cell.is_revealed = false;
            cell.is_flagged = false;
            cell.neighbor_mines = 0;
        }
        for &mine in mines {
            game.cells[mine].has_mine = true;
        }
        game.calculate_neighbor_mines();
        game.first_click = false;
        game.game_state = GameState::Playing;
        game.clear_count = 0;
        game.dirty_set.clear();
        game
    }

    fn reveal_known(game: &mut Minesweeper, index: usize) {
        game.cells[index].is_revealed = true;
        game.clear_count += 1;
    }

    #[test]
    fn sanitizes_settings() {
        assert_eq!(
            Minesweeper::sanitize_settings(1, 200, 99_999),
            (5, 100, 499)
        );
        assert_eq!(Minesweeper::sanitize_settings(16, 16, 0), (16, 16, 1));
    }

    #[test]
    fn calculates_neighbors() {
        let game = Minesweeper::new(5, 5, 3);
        assert_eq!(game.neighbors(0), &[1, 5, 6]);
        assert_eq!(game.neighbors(12).len(), 8);
    }

    #[test]
    fn first_click_excludes_mine() {
        let mut game = Minesweeper::new(5, 5, 24);
        game.reveal_cell(12);
        assert!(!game.cells[12].has_mine);
        assert_eq!(game.cells.iter().filter(|cell| cell.has_mine).count(), 24);
    }

    #[test]
    fn reveal_expands_zero_area() {
        let mut game = prepared_game(5, 5, &[24]);
        assert!(game.reveal_cell(0));
        assert!(game.cells[0].is_revealed);
        assert!(game.cells[18].is_revealed);
        assert!(!game.cells[24].is_revealed);
    }

    #[test]
    fn rule1_reveals_safe_neighbors() {
        let mut game = prepared_game(5, 5, &[0]);
        reveal_known(&mut game, 6);
        game.cells[0].is_flagged = true;

        let steps = game.apply_solving_rules();

        assert!(steps
            .iter()
            .any(|step| step.log.rule_type == RuleType::Rule1));
        for index in [1, 5, 7, 10, 11, 12] {
            assert!(game.cells[index].is_revealed, "index {index}");
        }
    }

    #[test]
    fn rule2_flags_all_remaining_neighbors() {
        let mut game = prepared_game(5, 5, &[0, 1, 5]);
        reveal_known(&mut game, 6);
        for index in [2, 7, 10, 11, 12] {
            game.cells[index].is_revealed = true;
        }

        let steps = game.apply_solving_rules();

        assert!(steps
            .iter()
            .any(|step| step.log.rule_type == RuleType::Rule2));
        for index in [0, 1, 5] {
            assert!(game.cells[index].is_flagged, "index {index}");
        }
    }

    #[test]
    fn rule3_reveals_unique_safe_cells() {
        let mut game = prepared_game(5, 5, &[]);
        reveal_known(&mut game, 6);
        reveal_known(&mut game, 7);
        game.cells[6].neighbor_mines = 1;
        game.cells[7].neighbor_mines = 4;
        for index in [0, 5, 10] {
            game.cells[index].is_revealed = false;
        }
        for index in [3, 8, 13] {
            game.cells[index].is_revealed = false;
        }

        let step = game.apply_advanced_rules(6, 7).expect("rule 3");

        assert_eq!(step.log.rule_type, RuleType::Rule3);
        for index in [0, 5, 10] {
            assert!(game.cells[index].is_revealed, "index {index}");
        }
    }

    #[test]
    fn rule4_flags_unique_mine_cells() {
        let mut game = prepared_game(5, 5, &[]);
        reveal_known(&mut game, 6);
        reveal_known(&mut game, 7);
        game.cells[6].neighbor_mines = 3;
        game.cells[7].neighbor_mines = 0;

        let step = game.apply_advanced_rules(6, 7).expect("rule 4");

        assert_eq!(step.log.rule_type, RuleType::Rule4);
        for index in [0, 5, 10] {
            assert!(game.cells[index].is_flagged, "index {index}");
        }
    }

    #[test]
    fn final_rule_flags_remaining_cells() {
        let mut game = prepared_game(5, 5, &[24]);
        for index in 0..24 {
            game.cells[index].is_revealed = true;
        }
        game.clear_count = 24;

        let step = game.apply_final_rule().expect("final rule");

        assert!(step.log.message.starts_with("最終ルール"));
        assert!(game.cells[24].is_flagged);
    }

    #[test]
    fn detects_win_and_flags_mines() {
        let mut game = prepared_game(5, 5, &[24]);
        for index in 0..24 {
            game.cells[index].is_revealed = true;
        }
        game.clear_count = 24;

        assert!(game.check_win());
        assert_eq!(game.game_state, GameState::Won);
        assert!(game.cells[24].is_flagged);
    }
}
