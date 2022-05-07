#include "Player.hpp"
#include "Level.hpp"

#include <cassert>
#include <iostream>

int main(int argc, char **argv) {
	{ //test player starting health:
		Player player;
		assert(player.health == 100);
	}

	{ //test level size:
		Level level;
		assert(level.tiles.size() == 10);
	}

	std::cout << "Success.\n";

	return 0;
}
