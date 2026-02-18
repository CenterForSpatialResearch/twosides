#!/usr/bin/env python3
"""
Generate zoom candidate locations for anthrome shift analysis using grid-based approach.

Scans the globe using a grid-based sampling method to find locations with the largest
intensive and cultured anthrome shifts within a 15x15 cell grid.

Usage:
    # Basic usage with defaults
    python3 7_generate_zoom_candidates.py --cell-history=utilities/cell-history-33km.json --topojson=../public/topojson/33km/2025AD.topojson --output-dir=../public/data --top-n=10

    # Recommended: 15x15 grid, 100 min cells, 12 cores, 2° sampling (fast, land-only)
    python3 7_generate_zoom_candidates.py --cell-history=utilities/cell-history-33km.json --topojson=../public/topojson/33km/2025AD.topojson --output-dir=../public/data --top-n=10 --grid-size=15 --min-cells=100 --processes=12 --grid-step=2.0

    # Higher accuracy: 1° sampling grid (slower but more thorough)
    python3 7_generate_zoom_candidates.py --cell-history=utilities/cell-history-33km.json --topojson=../public/topojson/33km/2025AD.topojson --output-dir=../public/data --top-n=10 --grid-size=15 --min-cells=100 --processes=12 --grid-step=1.0

    # Larger analysis area: 21x21 grid instead of 15x15
    python3 7_generate_zoom_candidates.py --cell-history=utilities/cell-history-33km.json --topojson=../public/topojson/33km/2025AD.topojson --output-dir=../public/data --top-n=10 --grid-size=21 --min-cells=100 --processes=12 --grid-step=2.0

Requirements:
    pip install geopy  # For automatic location name geocoding (optional)

Notes:
    - Geographic diversity is applied automatically using K-means clustering to ensure results are spread across the globe
    - Location names are added automatically via reverse geocoding (requires geopy and adds ~40 seconds for 40 locations)
    - Uses Nominatim (OpenStreetMap) with 1 req/sec rate limiting

Outputs:
    - zooms-intensive-since-1900.json
    - zooms-cultured-since-1900.json
    - zooms-intensive-since-2000.json
    - zooms-cultured-since-2000.json
"""

import json
import argparse
from pathlib import Path
from typing import Dict, List, Tuple
from multiprocessing import Pool, cpu_count
from functools import partial
import time

try:
    from geopy.geocoders import Nominatim
    from geopy.exc import GeocoderTimedOut, GeocoderServiceError
    GEOCODING_AVAILABLE = True
except ImportError:
    GEOCODING_AVAILABLE = False
    print("Warning: geopy not installed. Location names will use coordinates.")
    print("Install with: pip install geopy")


def reverse_geocode(lat: float, lon: float, geolocator) -> str:
    """
    Convert lat/lon to place name using reverse geocoding.

    Args:
        lat: Latitude
        lon: Longitude
        geolocator: Geopy geolocator instance

    Returns:
        Human-readable place name (e.g., "Fort Lee, USA")
    """
    try:
        location = geolocator.reverse(
            (lat, lon),
            exactly_one=True,
            language='en',
            addressdetails=True
        )

        if not location:
            return f"({lat:.2f}, {lon:.2f})"

        address = location.raw.get('address', {})

        # Priority order for name selection (most specific to least specific)
        name_candidates = [
            address.get('city'),
            address.get('town'),
            address.get('village'),
            address.get('municipality'),
            address.get('county'),
            address.get('state_district'),
            address.get('state'),
            address.get('region'),
            address.get('country')
        ]

        # Find first non-None name
        name = next((n for n in name_candidates if n), f"({lat:.2f}, {lon:.2f})")

        # Add country for context
        country = address.get('country', '')
        if country and name != country:
            return f"{name}, {country}"
        else:
            return name

    except GeocoderTimedOut:
        time.sleep(2)
        return reverse_geocode(lat, lon, geolocator)

    except (GeocoderServiceError, Exception) as e:
        return f"({lat:.2f}, {lon:.2f})"


def compute_polygon_centroid(coordinates: List) -> Tuple[float, float]:
    """
    Compute centroid of a polygon using coordinate list.

    Args:
        coordinates: List of [lon, lat] coordinate pairs (exterior ring)

    Returns:
        (lat, lon) tuple of centroid
    """
    if not coordinates or len(coordinates) < 3:
        return None

    # Use simple average of coordinates (good enough for small cells)
    sum_lon = 0
    sum_lat = 0
    count = len(coordinates)

    for lon, lat in coordinates:
        sum_lon += lon
        sum_lat += lat

    return (sum_lat / count, sum_lon / count)


def load_cell_positions(topojson_path: str) -> Dict[str, Tuple[float, float]]:
    """
    Build lookup of cell_id -> (lat, lon) from TopoJSON file.

    Args:
        topojson_path: Path to TopoJSON file (e.g., 2025AD.topojson)

    Returns:
        Dict mapping cell_id to (lat, lon) centroid
    """
    print(f"Loading TopoJSON from {topojson_path}...")

    with open(topojson_path, "r", encoding="utf-8") as f:
        topo_data = json.load(f)

    # Extract geometries from TopoJSON
    # TopoJSON structure: {type: "Topology", objects: {...}, arcs: [...], transform: {...}}
    if "objects" not in topo_data:
        raise ValueError("Invalid TopoJSON: missing 'objects' field")

    # Find the anthromes object (usually first object)
    objects = topo_data["objects"]
    if "anthromes" not in objects:
        # Try to find first object
        object_name = list(objects.keys())[0]
        print(f"Using object: {object_name}")
        features_obj = objects[object_name]
    else:
        features_obj = objects["anthromes"]

    # Extract geometries
    geometries = features_obj.get("geometries", [])
    if not geometries:
        raise ValueError("No geometries found in TopoJSON")

    print(f"Found {len(geometries)} geometries")

    # Get arcs and transform
    arcs = topo_data.get("arcs", [])
    transform = topo_data.get("transform", None)

    cell_positions = {}

    for geom in geometries:
        # Get cell ID from properties
        props = geom.get("properties", {})
        cell_id = str(props.get("i", ""))

        if not cell_id:
            continue

        # Get coordinates by decoding arcs
        geom_type = geom.get("type")

        # For simplicity, we'll use a bounding box center or first arc centroid
        # Full TopoJSON decoding is complex, so we'll use a simplified approach

        # If we have arcs reference, decode first arc
        if "arcs" in geom:
            arc_refs = geom["arcs"]

            # Handle Polygon (single ring list)
            if geom_type == "Polygon":
                # Use first (exterior) ring
                if arc_refs and len(arc_refs) > 0:
                    first_ring_refs = arc_refs[0]
                    coords = decode_arc_sequence(first_ring_refs, arcs, transform)
                    centroid = compute_polygon_centroid(coords)
                    if centroid:
                        cell_positions[cell_id] = centroid

            # Handle MultiPolygon
            elif geom_type == "MultiPolygon":
                # Use first polygon's first ring
                if arc_refs and len(arc_refs) > 0 and len(arc_refs[0]) > 0:
                    first_ring_refs = arc_refs[0][0]
                    coords = decode_arc_sequence(first_ring_refs, arcs, transform)
                    centroid = compute_polygon_centroid(coords)
                    if centroid:
                        cell_positions[cell_id] = centroid

    print(f"Extracted {len(cell_positions)} cell positions")

    return cell_positions


def decode_arc_sequence(arc_refs: List[int], arcs: List, transform: Dict) -> List[Tuple[float, float]]:
    """
    Decode a sequence of arc references into coordinates.

    Args:
        arc_refs: List of arc indices (negative = reversed)
        arcs: List of arc coordinate deltas
        transform: Transform object with scale and translate

    Returns:
        List of [lon, lat] coordinates
    """
    coordinates = []

    for arc_ref in arc_refs:
        arc_idx = arc_ref if arc_ref >= 0 else ~arc_ref
        arc = arcs[arc_idx]

        # Decode arc deltas
        arc_coords = decode_arc(arc, transform)

        # Reverse if negative reference
        if arc_ref < 0:
            arc_coords = list(reversed(arc_coords))

        # Skip first point if not first arc (avoid duplicates)
        if coordinates:
            arc_coords = arc_coords[1:]

        coordinates.extend(arc_coords)

    return coordinates


def decode_arc(arc: List[List[int]], transform: Dict) -> List[Tuple[float, float]]:
    """
    Decode a single arc from delta-encoded integers to actual coordinates.

    Args:
        arc: List of [dx, dy] delta pairs
        transform: Transform object with scale and translate

    Returns:
        List of [lon, lat] coordinates
    """
    if not transform:
        # No transform, return as-is (unusual)
        return [(x, y) for x, y in arc]

    scale = transform.get("scale", [1, 1])
    translate = transform.get("translate", [0, 0])

    coordinates = []
    x = 0
    y = 0

    for dx, dy in arc:
        x += dx
        y += dy

        lon = x * scale[0] + translate[0]
        lat = y * scale[1] + translate[1]

        coordinates.append((lon, lat))

    return coordinates


def build_spatial_grid_index(cell_positions: Dict[str, Tuple[float, float]], resolution_km: float = 33.0) -> Dict[Tuple[int, int], str]:
    """
    Build spatial grid index mapping grid coordinates to cell IDs.

    Args:
        cell_positions: Dict of cell_id -> (lat, lon)
        resolution_km: Cell resolution in kilometers (default: 33km)

    Returns:
        Dict mapping (grid_lat, grid_lon) -> cell_id
    """
    print("Building spatial grid index...")
    grid_index = {}

    # Convert km to approximate degrees (111km per degree at equator)
    grid_spacing = resolution_km / 111.0

    for cell_id, (lat, lon) in cell_positions.items():
        # Round to grid coordinates
        grid_lat = round(lat / grid_spacing)
        grid_lon = round(lon / grid_spacing)
        grid_index[(grid_lat, grid_lon)] = cell_id

    print(f"Built grid index with {len(grid_index)} entries")
    return grid_index


def extract_grid_cells(
    center_lat: float,
    center_lon: float,
    grid_size: int,
    grid_index: Dict[Tuple[int, int], str],
    resolution_km: float = 33.0
) -> List[str]:
    """
    Extract NxN grid of cell IDs around center point.

    Args:
        center_lat: Center latitude
        center_lon: Center longitude
        grid_size: Size of grid (e.g., 15 for 15x15)
        grid_index: Spatial grid index
        resolution_km: Cell resolution in kilometers

    Returns:
        List of cell IDs in the grid
    """
    grid_spacing = resolution_km / 111.0
    half_size = grid_size // 2
    cell_ids = []

    # Convert center to grid coordinates
    center_grid_lat = round(center_lat / grid_spacing)
    center_grid_lon = round(center_lon / grid_spacing)

    for dlat in range(-half_size, half_size + 1):
        for dlon in range(-half_size, half_size + 1):
            grid_lat = center_grid_lat + dlat
            grid_lon = center_grid_lon + dlon

            cell_id = grid_index.get((grid_lat, grid_lon))
            if cell_id:
                cell_ids.append(cell_id)

    return cell_ids


def calculate_grid_shift(
    center_lat: float,
    center_lon: float,
    grid_size: int,
    grid_index: Dict[Tuple[int, int], str],
    cell_history: Dict,
    start_year: str,
    end_year: str,
    resolution_km: float = 33.0
) -> Tuple[float, int]:
    """
    Calculate average anthrome shift for a grid of cells.

    Args:
        center_lat: Center latitude
        center_lon: Center longitude
        grid_size: Size of grid (e.g., 15 for 15x15)
        grid_index: Spatial grid index
        cell_history: Full cell history data
        start_year: Start year (e.g., "1900AD")
        end_year: End year (e.g., "2025AD")
        resolution_km: Cell resolution in kilometers

    Returns:
        (average_shift, cell_count)
    """
    # Extract grid cells
    cell_ids = extract_grid_cells(center_lat, center_lon, grid_size, grid_index, resolution_km)

    # Skip if mostly ocean (less than minimum threshold)
    # We'll check this after calculating to get accurate land cell count
    total_shift = 0
    land_cell_count = 0

    for cell_id in cell_ids:
        year_data = cell_history.get(cell_id, {})
        start_anthrome = year_data.get(start_year)
        end_anthrome = year_data.get(end_year)

        # Skip if no data or no-land cells
        if not start_anthrome or not end_anthrome:
            continue
        if start_anthrome == 70 or end_anthrome == 70:
            continue

        # Calculate shift (positive = intensification)
        shift = start_anthrome - end_anthrome

        total_shift += shift
        land_cell_count += 1

    if land_cell_count == 0:
        return 0, 0

    return total_shift / land_cell_count, land_cell_count


def generate_sample_grid(lat_step: float = 1.0, lon_step: float = 1.0) -> List[Tuple[float, float]]:
    """
    Generate a grid of sample points across the globe.

    Args:
        lat_step: Latitude spacing in degrees
        lon_step: Longitude spacing in degrees

    Returns:
        List of (lat, lon) tuples
    """
    sample_points = []

    # Sample from -90 to 90 latitude, -180 to 180 longitude
    lat = -90 + lat_step / 2
    while lat <= 90:
        lon = -180 + lon_step / 2
        while lon <= 180:
            sample_points.append((lat, lon))
            lon += lon_step
        lat += lat_step

    return sample_points


def process_sample_point(
    args: Tuple[int, float, float],
    grid_index: Dict[Tuple[int, int], str],
    cell_history: Dict,
    start_year: str,
    end_year: str,
    grid_size: int,
    resolution_km: float,
    min_cells: int
) -> Tuple[int, float, float, float, int]:
    """
    Process a single sample point (worker function for parallel processing).

    Args:
        args: Tuple of (index, lat, lon)
        grid_index: Spatial grid index
        cell_history: Cell history data
        start_year: Start year
        end_year: End year
        grid_size: Size of cell grid
        resolution_km: Cell resolution in km
        min_cells: Minimum land cells required

    Returns:
        Tuple of (index, lat, lon, shift, cell_count)
    """
    idx, lat, lon = args

    shift, cell_count = calculate_grid_shift(
        lat, lon, grid_size, grid_index, cell_history, start_year, end_year, resolution_km
    )

    # Filter out if below minimum threshold
    if cell_count < min_cells:
        return (idx, lat, lon, 0, 0)

    return (idx, lat, lon, shift, cell_count)


def haversine_distance(lat1, lon1, lat2, lon2):
    """
    Calculate great circle distance between two points in km.

    Args:
        lat1, lon1: First point coordinates
        lat2, lon2: Second point coordinates

    Returns:
        Distance in kilometers
    """
    import math
    R = 6371  # Earth radius in km
    lat1_rad = math.radians(lat1)
    lat2_rad = math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)

    a = math.sin(dlat/2)**2 + math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(dlon/2)**2
    c = 2 * math.asin(math.sqrt(a))

    return R * c


def kmeans_cluster_locations(locations: List[Dict], n_clusters: int) -> List[List[Dict]]:
    """
    Cluster locations using K-means based on geographic coordinates.

    Args:
        locations: List of location dicts with 'lat' and 'lon' keys
        n_clusters: Number of clusters to create

    Returns:
        List of clusters, each containing location dicts
    """
    import random

    if len(locations) <= n_clusters:
        return [[loc] for loc in locations]

    # Initialize centroids randomly
    centroids = random.sample(locations, n_clusters)
    centroid_coords = [(c['lat'], c['lon']) for c in centroids]

    # Run K-means for fixed iterations
    for _ in range(20):  # 20 iterations usually sufficient
        # Assign each location to nearest centroid
        clusters = [[] for _ in range(n_clusters)]

        for loc in locations:
            min_dist = float('inf')
            closest_cluster = 0

            for i, (clat, clon) in enumerate(centroid_coords):
                dist = haversine_distance(loc['lat'], loc['lon'], clat, clon)
                if dist < min_dist:
                    min_dist = dist
                    closest_cluster = i

            clusters[closest_cluster].append(loc)

        # Update centroids (mean of each cluster)
        new_centroids = []
        for cluster in clusters:
            if cluster:
                mean_lat = sum(loc['lat'] for loc in cluster) / len(cluster)
                mean_lon = sum(loc['lon'] for loc in cluster) / len(cluster)
                new_centroids.append((mean_lat, mean_lon))
            else:
                # Keep old centroid if cluster is empty
                new_centroids.append(centroid_coords[len(new_centroids)])

        centroid_coords = new_centroids

    # Final assignment
    clusters = [[] for _ in range(n_clusters)]
    for loc in locations:
        min_dist = float('inf')
        closest_cluster = 0

        for i, (clat, clon) in enumerate(centroid_coords):
            dist = haversine_distance(loc['lat'], loc['lon'], clat, clon)
            if dist < min_dist:
                min_dist = dist
                closest_cluster = i

        clusters[closest_cluster].append(loc)

    # Remove empty clusters
    clusters = [c for c in clusters if c]

    return clusters


def apply_geographic_diversity(results: List[Dict], top_n: int, intensive: bool) -> List[Dict]:
    """
    Apply geographic diversity using K-means clustering.

    Clusters all results geographically, then takes the best result from each cluster.
    This ensures geographic diversity while still prioritizing the highest shifts.

    Args:
        results: List of results (already sorted by shift)
        top_n: Number of diverse locations to return
        intensive: Whether this is intensive or cultured shift

    Returns:
        List of geographically diverse top results
    """
    if len(results) <= top_n:
        return results

    print(f"Applying geographic diversity (K-means clustering with {top_n} clusters)...")

    # Cluster into top_n clusters
    clusters = kmeans_cluster_locations(results, top_n)

    print(f"Created {len(clusters)} geographic clusters")

    # Take best (highest shift magnitude) from each cluster
    diverse_results = []
    for i, cluster in enumerate(clusters):
        if not cluster:
            continue

        # Sort cluster by shift magnitude
        if intensive:
            best = max(cluster, key=lambda x: x['shift'])
        else:
            best = min(cluster, key=lambda x: x['shift'])

        diverse_results.append(best)
        print(f"  Cluster {i+1}: {len(cluster)} locations, best shift = {best['shift']:.3f}")

    # Sort final results by shift magnitude
    if intensive:
        diverse_results.sort(key=lambda x: x['shift'], reverse=True)
    else:
        diverse_results.sort(key=lambda x: x['shift'])

    return diverse_results


def find_top_shift_locations(
    grid_index: Dict[Tuple[int, int], str],
    cell_history: Dict,
    start_year: str,
    end_year: str,
    grid_size: int,
    top_n: int,
    intensive: bool,
    resolution_km: float = 33.0,
    min_cells: int = 50,
    num_processes: int = None,
    grid_step: float = 2.0
) -> List[Dict]:
    """
    Find top N locations with largest shifts using parallel processing.

    Args:
        grid_index: Spatial grid index
        cell_history: Full cell history data
        start_year: Start year string (e.g., "1900AD")
        end_year: End year string (e.g., "2025AD")
        grid_size: Size of cell grid (e.g., 15 for 15x15)
        top_n: Number of top locations to return
        intensive: If True, find intensification; if False, find cultured shifts
        resolution_km: Cell resolution in km
        min_cells: Minimum land cells required
        num_processes: Number of parallel processes (default: CPU count)
        grid_step: Grid spacing in degrees (default: 2.0)

    Returns:
        List of location dicts with lat, lon, shift, title, description
    """
    sample_points = generate_sample_grid(lat_step=grid_step, lon_step=grid_step)

    if num_processes is None:
        num_processes = cpu_count()

    print(f"Scanning {len(sample_points)} sample points for {'intensive' if intensive else 'cultured'} shifts...")
    print(f"Using {num_processes} parallel processes")
    print(f"Grid size: {grid_size}x{grid_size} cells, minimum {min_cells} land cells required")

    # Prepare work items with indices
    work_items = [(i, lat, lon) for i, (lat, lon) in enumerate(sample_points)]

    # Create partial function with fixed arguments
    worker_func = partial(
        process_sample_point,
        grid_index=grid_index,
        cell_history=cell_history,
        start_year=start_year,
        end_year=end_year,
        grid_size=grid_size,
        resolution_km=resolution_km,
        min_cells=min_cells
    )

    # Process in parallel with progress tracking
    results = []
    completed = 0

    with Pool(processes=num_processes) as pool:
        for result in pool.imap_unordered(worker_func, work_items, chunksize=100):
            idx, lat, lon, shift, cell_count = result

            # Progress update every 1000 items
            completed += 1
            if completed % 1000 == 0:
                print(f"  Progress: {completed}/{len(sample_points)} ({100*completed/len(sample_points):.1f}%)")

            # Skip if below threshold (already filtered in worker)
            if cell_count == 0:
                continue

            results.append({
                "lat": lat,
                "lon": lon,
                "shift": shift,
                "cell_count": cell_count
            })

    print(f"Found {len(results)} valid locations (with {min_cells}+ land cells)")

    # Sort by shift
    if intensive:
        # Largest positive shifts (most intensification)
        results.sort(key=lambda x: x["shift"], reverse=True)
    else:
        # Largest negative shifts (most cultured)
        results.sort(key=lambda x: x["shift"])

    # Apply geographic diversity using K-means clustering
    top_results = apply_geographic_diversity(results, top_n, intensive)

    # Initialize geocoder if available
    geolocator = None
    if GEOCODING_AVAILABLE:
        print(f"\nAdding location names via geocoding (this may take ~{len(top_results)} seconds)...")
        geolocator = Nominatim(user_agent="twosides-anthrome-zooms/1.0")

    # Format for output
    formatted = []
    for i, result in enumerate(top_results):
        lat = round(result["lat"], 4)
        lon = round(result["lon"], 4)
        shift_type = "Intensive" if intensive else "Cultured"

        # Geocode location name if available
        if geolocator:
            title = reverse_geocode(lat, lon, geolocator)
            print(f"  {i+1}/{len(top_results)}: ({lat}, {lon}) → {title}")
            # Rate limiting: 1 request per second (Nominatim requirement)
            if i < len(top_results) - 1:
                time.sleep(1.1)
        else:
            title = f"{shift_type} Shift #{i+1}"

        formatted.append({
            "title": title,
            "lat": lat,
            "lon": lon,
            "description": f"Avg shift: {result['shift']:.3f} ({result['cell_count']} cells)",
            "shift": round(result["shift"], 4),
            "cell_count": result["cell_count"]
        })

    return formatted


def main():
    parser = argparse.ArgumentParser(
        description="Generate zoom candidate locations for anthrome shift analysis (grid-based)"
    )
    parser.add_argument(
        "--cell-history",
        required=True,
        help="Path to cell-history JSON file (input)",
    )
    parser.add_argument(
        "--topojson",
        required=True,
        help="Path to TopoJSON file for extracting cell positions (e.g., 2025AD.topojson)",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Directory to write output JSON files",
    )
    parser.add_argument(
        "--top-n",
        type=int,
        default=10,
        help="Number of top locations to generate (default: 10)",
    )
    parser.add_argument(
        "--grid-size",
        type=int,
        default=15,
        help="Size of cell grid to analyze (default: 15 for 15x15 grid)",
    )
    parser.add_argument(
        "--resolution",
        type=float,
        default=33.0,
        help="Cell resolution in kilometers (default: 33.0)",
    )
    parser.add_argument(
        "--min-cells",
        type=int,
        default=50,
        help="Minimum land cells required in grid (default: 50)",
    )
    parser.add_argument(
        "--processes",
        type=int,
        default=None,
        help="Number of parallel processes (default: CPU count)",
    )
    parser.add_argument(
        "--grid-step",
        type=float,
        default=2.0,
        help="Sample grid spacing in degrees (default: 2.0 for faster processing, use 1.0 for higher accuracy)",
    )

    args = parser.parse_args()

    # Load cell history
    print(f"Loading cell history from {args.cell_history}...")
    with open(args.cell_history, "r", encoding="utf-8") as f:
        cell_history = json.load(f)

    print(f"Loaded {len(cell_history)} cells")

    # Build cell positions lookup from TopoJSON
    print("\nBuilding cell position lookup from TopoJSON...")
    cell_positions = load_cell_positions(args.topojson)

    if not cell_positions:
        print("\nERROR: Cell positions could not be determined.")
        print("Check that the TopoJSON file exists and has the expected structure.")
        return

    print(f"Located {len(cell_positions)} cell positions")

    # Build spatial grid index
    grid_index = build_spatial_grid_index(cell_positions, args.resolution)

    # Create output directory
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Generate candidates for each category
    categories = [
        ("intensive", "1900AD", "Intensive shifts since 1900"),
        ("cultured", "1900AD", "Cultured shifts since 1900"),
        ("intensive", "2000AD", "Intensive shifts since 2000"),
        ("cultured", "2000AD", "Cultured shifts since 2000"),
    ]

    for shift_type, start_year, description in categories:
        print(f"\n{'='*60}")
        print(f"{description}...")
        print(f"{'='*60}")

        intensive = shift_type == "intensive"
        year_suffix = "1900" if start_year == "1900AD" else "2000"
        output_file = output_dir / f"zooms-{shift_type}-since-{year_suffix}.json"

        top_locations = find_top_shift_locations(
            grid_index,
            cell_history,
            start_year,
            "2025AD",
            args.grid_size,
            args.top_n,
            intensive,
            args.resolution,
            args.min_cells,
            args.processes,
            args.grid_step
        )

        # Write output
        print(f"\nWriting to {output_file}...")
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(top_locations, f, indent=2)

        print(f"Generated {len(top_locations)} locations")

        # Print sample
        if top_locations:
            print(f"\nTop 3 results:")
            for i, loc in enumerate(top_locations[:3]):
                print(f"  #{i+1}: ({loc['lat']:.2f}, {loc['lon']:.2f}) - shift={loc['shift']:.3f}, cells={loc['cell_count']}")

    print("\n" + "="*60)
    print("Done!")
    print("="*60)


if __name__ == "__main__":
    main()
